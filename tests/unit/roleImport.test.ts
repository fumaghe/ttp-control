/**
 * Import Discord → database dei ruoli assegnati a mano (`IMPORT_SAFE`).
 *
 * Test di INTEGRAZIONE in memoria: girano i service reali — riconciliazione,
 * import, membership, audit — sopra repository in memoria e un gateway Discord
 * finto. Quello che si verifica è il comportamento osservabile del gestionale
 * dopo che qualcuno ha toccato i ruoli dalla UI di Discord, non le chiamate
 * interne di un doppio.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  AuditAction,
  MemberHistoryEvent,
  MemberRank,
  MemberStatus,
  SpecialRole,
} from '../../src/generated/prisma/enums.js';
import type { RoleSyncMode } from '../../src/config/env.js';
import {
  createMemberReconciliationService,
  type MemberReconciliationService,
} from '../../src/services/memberReconciliationService.js';
import type { GuildMemberSnapshot } from '../../src/services/roleGateway.js';
import {
  addFakeMember,
  CHANNEL_IDS,
  createHarness,
  GUILD_ID,
  ROLE_IDS,
  snapshotOf,
  verifyUser,
  type Harness,
} from '../support/harness.js';

const OG = '400000000000000000';
const MEMBER = '400000000000000001';
const OTHER = '400000000000000002';

let h: Harness;
let cron: MemberReconciliationService;

function snapshots(): GuildMemberSnapshot[] {
  return [...h.guild.members.values()].filter((member) => member.present).map(snapshotOf);
}

function build(mode: RoleSyncMode = 'IMPORT_SAFE'): MemberReconciliationService {
  return createMemberReconciliationService({
    repos: h.repos,
    roleRegistry: h.roles,
    audit: h.audit,
    blacklist: h.blacklist,
    roleImport: h.roleImport,
    mode,
    listAllGuildMembers: () => Promise.resolve(snapshots()),
    guildId: GUILD_ID,
  });
}

/** I ruoli Discord di un membro finto, manipolati come farebbe un admin. */
function roles(discordId: string): Set<string> {
  const member = h.guild.members.get(discordId);
  if (!member) throw new Error(`Membro finto ${discordId} inesistente`);
  return member.roles;
}

function historyEvents(discordId: string): MemberHistoryEvent[] {
  return h.store.history.filter((e) => e.discordId === discordId).map((e) => e.event);
}

function auditFor(discordId: string, action: AuditAction) {
  return h.store.audit.filter(
    (entry) => entry.targetDiscordId === discordId && entry.action === action,
  );
}

/** Annunci pubblici Put On / Put Off effettivamente pubblicati. */
function announcements() {
  return h.guild.messages.filter((message) => message.channelId === CHANNEL_IDS.putOnOff);
}

/** Titolo dell'embed di un annuncio: distingue PUT ON da PUT OFF. */
function announcementTitles(): string[] {
  return announcements().map((message) => {
    const embed = message.payload.embeds?.[0];
    const json = embed && 'toJSON' in embed ? embed.toJSON() : embed;
    return json?.title ?? '';
  });
}

/**
 * Membro TTP regolare, creato dal comando: database e Discord allineati.
 * È il punto di partenza di ogni test che poi tocca i ruoli a mano.
 */
async function createMemberViaCommand(rank: MemberRank = MemberRank.RESIDENT): Promise<void> {
  addFakeMember(h.guild, MEMBER, { position: 1 });
  await verifyUser(h, MEMBER);
  await h.members.addToGang({
    discordId: MEMBER,
    actorDiscordId: OG,
    rank,
    reason: 'ingresso',
    source: 'manual',
  });
}

beforeEach(() => {
  h = createHarness();
  addFakeMember(h.guild, OG, {
    roles: [ROLE_IDS.verified, ROLE_IDS.ttp, ROLE_IDS.og],
    position: 90,
  });
  cron = build();
});

// =============================================================================
// Import validi
// =============================================================================

describe('Verified assegnato manualmente', () => {
  beforeEach(async () => {
    addFakeMember(h.guild, MEMBER, { displayName: 'Tony Montana' });
    await cron.run(); // seed
  });

  it('crea la verifica amministrativa mancante', async () => {
    roles(MEMBER).add(ROLE_IDS.verified);
    const report = await cron.run();

    expect(report.verificationsImported).toBe(1);
    const verification = await h.repos.verifications.findActive(MEMBER);
    expect(verification).not.toBeNull();
    // Stessa forma di `/community verified`: i dati IC non sono stati raccolti
    // da nessun modal, e il segnaposto lo dice.
    expect(verification?.rpName).toBe('—');
    expect(verification?.oocName).toBe('Tony Montana');
  });

  it('aggiorna `DiscordProfile.verifiedAt`', async () => {
    roles(MEMBER).add(ROLE_IDS.verified);
    await cron.run();

    const profile = await h.repos.profiles.findByDiscordId(MEMBER);
    expect(profile?.verifiedAt).not.toBeNull();
  });

  it('registra l’audit senza inventare un autore', async () => {
    roles(MEMBER).add(ROLE_IDS.verified);
    await cron.run();

    const entry = auditFor(MEMBER, AuditAction.USER_VERIFIED)[0];
    expect(entry?.actorDiscordId).toBeNull();
    expect(entry?.metadata).toMatchObject({ source: 'discord_manual', imported: true });
  });

  it('NON riassegna il ruolo a Discord: è già lì', async () => {
    roles(MEMBER).add(ROLE_IDS.verified);
    const before = new Set(roles(MEMBER));
    await cron.run();
    expect([...roles(MEMBER)]).toEqual([...before]);
  });
});

describe('ingresso TTP assegnato manualmente', () => {
  beforeEach(async () => {
    addFakeMember(h.guild, MEMBER, { position: 1 });
    await verifyUser(h, MEMBER);
    await cron.run(); // seed
  });

  it('crea il membro con il rank letto da Discord', async () => {
    roles(MEMBER).add(ROLE_IDS.ttp);
    roles(MEMBER).add(ROLE_IDS.resident);

    const report = await cron.run();

    expect(report.membersCreated).toBe(1);
    const dbMember = await h.repos.members.findByDiscordId(MEMBER);
    expect(dbMember?.rank).toBe(MemberRank.RESIDENT);
    expect(dbMember?.status).toBe(MemberStatus.ACTIVE);
  });

  it('funziona con un rank diverso da Resident', async () => {
    roles(MEMBER).add(ROLE_IDS.ttp);
    roles(MEMBER).add(ROLE_IDS.bigHomie);
    await cron.run();

    expect((await h.repos.members.findByDiscordId(MEMBER))?.rank).toBe(MemberRank.BIG_HOMIE);
  });

  it('entra direttamente INACTIVE se ha anche quel ruolo', async () => {
    roles(MEMBER).add(ROLE_IDS.ttp);
    roles(MEMBER).add(ROLE_IDS.resident);
    roles(MEMBER).add(ROLE_IDS.inactive);
    await cron.run();

    expect((await h.repos.members.findByDiscordId(MEMBER))?.status).toBe(MemberStatus.INACTIVE);
  });

  it('registra JOINED_TTP e l’audit dell’ingresso', async () => {
    roles(MEMBER).add(ROLE_IDS.ttp);
    roles(MEMBER).add(ROLE_IDS.resident);
    await cron.run();

    expect(historyEvents(MEMBER)).toContain(MemberHistoryEvent.JOINED_TTP);
    const entry = auditFor(MEMBER, AuditAction.TTP_ADDED)[0];
    expect(entry?.actorDiscordId).toBeNull();
    expect(entry?.metadata).toMatchObject({ source: 'discord_manual', imported: true });
  });

  it('NON pubblica un Put On: entrare nella gang non è una promozione', async () => {
    roles(MEMBER).add(ROLE_IDS.ttp);
    roles(MEMBER).add(ROLE_IDS.resident);
    await cron.run();

    expect(announcements()).toHaveLength(0);
  });
});

describe('ruoli già presenti al momento del join', () => {
  it('un nuovo arrivato con i ruoli già addosso viene importato subito', async () => {
    // Finestra reale: l'utente entra e qualcuno gli assegna i ruoli PRIMA che
    // il cron giri. Senza questo, lo snapshot li fotograferebbe come stato di
    // partenza e non risulterebbero mai più "cambiati": il membro resterebbe
    // fuori dal database per sempre.
    addFakeMember(h.guild, OTHER);
    await cron.run(); // seed senza MEMBER

    addFakeMember(h.guild, MEMBER, {
      roles: [ROLE_IDS.verified, ROLE_IDS.ttp, ROLE_IDS.resident],
      position: 1,
    });

    const report = await cron.run();

    expect(report.joined).toBe(1);
    expect(report.membersCreated).toBe(1);
    expect((await h.repos.members.findByDiscordId(MEMBER))?.rank).toBe(MemberRank.RESIDENT);
  });

  it('un nuovo arrivato senza ruoli non produce nessun import', async () => {
    addFakeMember(h.guild, OTHER);
    await cron.run();

    addFakeMember(h.guild, MEMBER);
    const report = await cron.run();

    expect(report.joined).toBe(1);
    expect(report.imports).toBe(0);
    expect(report.warnings).toBe(0);
  });
});

describe('rientro di un ex membro', () => {
  it('riusa la riga esistente e azzera leftTtpAt', async () => {
    await createMemberViaCommand(MemberRank.LOC);
    await h.members.removeFromGang({
      discordId: MEMBER,
      actorDiscordId: OG,
      reason: 'uscita',
    });
    await cron.run(); // seed a stato già uscito

    const before = await h.repos.members.findByDiscordId(MEMBER);
    expect(before?.status).toBe(MemberStatus.LEFT);

    // Un admin gli rimette TTP + rank a mano.
    roles(MEMBER).add(ROLE_IDS.ttp);
    roles(MEMBER).add(ROLE_IDS.resident);
    const report = await cron.run();

    expect(report.membersReactivated).toBe(1);
    const after = await h.repos.members.findByDiscordId(MEMBER);
    expect(after?.id).toBe(before?.id);
    expect(after?.status).toBe(MemberStatus.ACTIVE);
    expect(after?.rank).toBe(MemberRank.RESIDENT);
    expect(after?.leftTtpAt).toBeNull();
  });

  it('conserva lo storico precedente invece di ricominciarlo', async () => {
    await createMemberViaCommand(MemberRank.LOC);
    await h.members.removeFromGang({ discordId: MEMBER, actorDiscordId: OG, reason: 'uscita' });
    await cron.run();

    roles(MEMBER).add(ROLE_IDS.ttp);
    roles(MEMBER).add(ROLE_IDS.resident);
    await cron.run();

    // L'uscita resta leggibile accanto al rientro.
    expect(historyEvents(MEMBER)).toEqual(
      expect.arrayContaining([
        MemberHistoryEvent.JOINED_TTP,
        MemberHistoryEvent.LEFT_TTP,
        MemberHistoryEvent.JOINED_TTP,
      ]),
    );
  });
});

describe('cambio di rank manuale', () => {
  beforeEach(async () => {
    await createMemberViaCommand(MemberRank.TINY_LOC);
    await cron.run(); // seed
  });

  it('verso l’alto aggiorna il database e pubblica UN solo Put On', async () => {
    roles(MEMBER).delete(ROLE_IDS.tinyLoc);
    roles(MEMBER).add(ROLE_IDS.og);

    const report = await cron.run();

    expect(report.ranksUpdated).toBe(1);
    expect((await h.repos.members.findByDiscordId(MEMBER))?.rank).toBe(MemberRank.OG);
    expect(announcementTitles()).toEqual(['🔥 PUT ON']);
    expect(historyEvents(MEMBER)).toContain(MemberHistoryEvent.PROMOTED);
  });

  it('verso il basso pubblica UN solo Put Off', async () => {
    roles(MEMBER).delete(ROLE_IDS.tinyLoc);
    roles(MEMBER).add(ROLE_IDS.resident);

    await cron.run();

    expect((await h.repos.members.findByDiscordId(MEMBER))?.rank).toBe(MemberRank.RESIDENT);
    expect(announcementTitles()).toEqual(['📉 PUT OFF']);
    expect(historyEvents(MEMBER)).toContain(MemberHistoryEvent.DEMOTED);
  });

  it('la direzione segue RANK_ORDER, non l’ordine alfabetico', async () => {
    // `BIG` < `BIG_HOMIE` nella gerarchia ma 'BIG_HOMIE' > 'BIG' in ordine
    // alfabetico: un confronto fra stringhe annuncerebbe la direzione sbagliata.
    roles(MEMBER).delete(ROLE_IDS.tinyLoc);
    roles(MEMBER).add(ROLE_IDS.big);
    await cron.run();

    expect(announcementTitles()).toEqual(['🔥 PUT ON']);
  });

  it('attribuisce l’annuncio a "modifica manuale", non a una mention vuota', async () => {
    roles(MEMBER).delete(ROLE_IDS.tinyLoc);
    roles(MEMBER).add(ROLE_IDS.og);
    await cron.run();

    const embed = announcements()[0]?.payload.embeds?.[0];
    const json = embed && 'toJSON' in embed ? embed.toJSON() : embed;
    const actorField = json?.fields?.find((field) => field.name === 'Promosso da');

    expect(actorField?.value).toContain('Modifica manuale su Discord');
    expect(actorField?.value).not.toContain('<@null>');
    expect(actorField?.value).not.toContain('undefined');
  });

  it('NON riscrive i ruoli su Discord: sono già nello stato voluto', async () => {
    roles(MEMBER).delete(ROLE_IDS.tinyLoc);
    roles(MEMBER).add(ROLE_IDS.og);
    const before = new Set(roles(MEMBER));

    await cron.run();

    expect([...roles(MEMBER)].sort()).toEqual([...before].sort());
  });
});

describe('Inactive manuale', () => {
  beforeEach(async () => {
    await createMemberViaCommand();
    await cron.run();
  });

  it('aggiunto porta il membro a INACTIVE', async () => {
    roles(MEMBER).add(ROLE_IDS.inactive);
    const report = await cron.run();

    expect(report.statusesUpdated).toBe(1);
    expect((await h.repos.members.findByDiscordId(MEMBER))?.status).toBe(MemberStatus.INACTIVE);
    expect(historyEvents(MEMBER)).toContain(MemberHistoryEvent.SET_INACTIVE);
  });

  it('rimosso riporta il membro ad ACTIVE', async () => {
    roles(MEMBER).add(ROLE_IDS.inactive);
    await cron.run();

    roles(MEMBER).delete(ROLE_IDS.inactive);
    await cron.run();

    expect((await h.repos.members.findByDiscordId(MEMBER))?.status).toBe(MemberStatus.ACTIVE);
    expect(historyEvents(MEMBER)).toContain(MemberHistoryEvent.SET_ACTIVE);
  });

  it('non tocca rank né ruoli speciali', async () => {
    roles(MEMBER).add(ROLE_IDS.inactive);
    await cron.run();

    const dbMember = await h.repos.members.findByDiscordId(MEMBER);
    expect(dbMember?.rank).toBe(MemberRank.RESIDENT);
    expect(announcements()).toHaveLength(0);
  });
});

describe('badge e specializzazioni', () => {
  beforeEach(async () => {
    await createMemberViaCommand();
    await cron.run();
  });

  it('un ruolo speciale aggiunto a mano entra a database', async () => {
    roles(MEMBER).add(ROLE_IDS.shooter);
    const report = await cron.run();

    expect(report.specialRolesUpdated).toBe(1);
    const dbMember = await h.repos.members.findByDiscordId(MEMBER);
    expect(await h.members.listSpecialRoles(dbMember?.id ?? '')).toEqual([SpecialRole.SHOOTER]);
  });

  it('un ruolo speciale rimosso a mano esce dal database', async () => {
    roles(MEMBER).add(ROLE_IDS.honor1);
    await cron.run();

    roles(MEMBER).delete(ROLE_IDS.honor1);
    await cron.run();

    const dbMember = await h.repos.members.findByDiscordId(MEMBER);
    expect(await h.members.listSpecialRoles(dbMember?.id ?? '')).toEqual([]);
  });

  it('più ruoli speciali modificati insieme vengono allineati tutti', async () => {
    roles(MEMBER).add(ROLE_IDS.shooter);
    roles(MEMBER).add(ROLE_IDS.honor1);
    await cron.run();

    // Un admin scambia le decorazioni in un colpo solo.
    roles(MEMBER).delete(ROLE_IDS.honor1);
    roles(MEMBER).add(ROLE_IDS.mainShooter);
    roles(MEMBER).add(ROLE_IDS.firstDay);
    const report = await cron.run();

    expect(report.specialRolesUpdated).toBe(3);
    const dbMember = await h.repos.members.findByDiscordId(MEMBER);
    expect((await h.members.listSpecialRoles(dbMember?.id ?? '')).sort()).toEqual(
      [SpecialRole.SHOOTER, SpecialRole.MAIN_SHOOTER, SpecialRole.FIRST_DAY].sort(),
    );
  });

  it('storicizza e audita ogni modifica senza inventare un autore', async () => {
    roles(MEMBER).add(ROLE_IDS.shooter);
    await cron.run();

    expect(historyEvents(MEMBER)).toContain(MemberHistoryEvent.SPECIAL_ROLE_ADDED);
    const entry = auditFor(MEMBER, AuditAction.SPECIAL_ROLE_ADDED)[0];
    expect(entry?.actorDiscordId).toBeNull();
    expect(entry?.metadata).toMatchObject({ source: 'discord_manual' });

    const dbMember = await h.repos.members.findByDiscordId(MEMBER);
    const assignment = [...h.store.specialRoles.values()].find((e) => e.memberId === dbMember?.id);
    // La colonna era già nullable: qui si verifica che il contratto la accetti.
    expect(assignment?.assignedByDiscordId).toBeNull();
  });
});

describe('Friend e Mafia restano Discord-first', () => {
  it('una modifica manuale non genera divergenze né tabelle nuove', async () => {
    addFakeMember(h.guild, MEMBER);
    await verifyUser(h, MEMBER);
    await cron.run();

    roles(MEMBER).add(ROLE_IDS.friend);
    const report = await cron.run();

    expect(report.warnings).toBe(0);
    expect(report.imports).toBe(0);

    // Le liste community continuano a leggerli da Discord, senza passare dal
    // database: non c'è nessuna tabella da tenere allineata.
    const friends = await h.community.list({ kind: 'friend', excludeTtp: false });
    expect(friends.some((entry) => entry.discordId === MEMBER)).toBe(true);
  });

  it('lo snapshot avanza comunque', async () => {
    addFakeMember(h.guild, MEMBER);
    await cron.run();

    roles(MEMBER).add(ROLE_IDS.mafia);
    await cron.run();

    const rows = await h.repos.snapshots.listForGuild(GUILD_ID);
    const row = rows.find((entry) => entry.discordId === MEMBER);
    expect(row?.roleIds).toContain(ROLE_IDS.mafia);
  });
});

// =============================================================================
// Stati invalidi: si segnalano, non si importano
// =============================================================================

describe('stati invalidi non toccano il database', () => {
  beforeEach(async () => {
    addFakeMember(h.guild, MEMBER, { position: 1 });
    await cron.run(); // seed
  });

  async function expectWarningWithoutMember(): Promise<void> {
    const report = await cron.run();
    expect(report.warnings + report.blocked).toBeGreaterThan(0);
    expect(report.imports).toBe(0);
    expect(await h.repos.members.findByDiscordId(MEMBER)).toBeNull();
  }

  it('TTP senza Verified', async () => {
    roles(MEMBER).add(ROLE_IDS.ttp);
    roles(MEMBER).add(ROLE_IDS.resident);
    await expectWarningWithoutMember();
  });

  it('TTP senza rank', async () => {
    roles(MEMBER).add(ROLE_IDS.verified);
    roles(MEMBER).add(ROLE_IDS.ttp);
    await expectWarningWithoutMember();
  });

  it('TTP con due rank non sceglie il più alto', async () => {
    roles(MEMBER).add(ROLE_IDS.verified);
    roles(MEMBER).add(ROLE_IDS.ttp);
    roles(MEMBER).add(ROLE_IDS.resident);
    roles(MEMBER).add(ROLE_IDS.og);
    await expectWarningWithoutMember();
  });

  it('rank senza TTP', async () => {
    roles(MEMBER).add(ROLE_IDS.verified);
    roles(MEMBER).add(ROLE_IDS.og);
    await expectWarningWithoutMember();
  });

  it('Inactive senza membership TTP', async () => {
    roles(MEMBER).add(ROLE_IDS.verified);
    roles(MEMBER).add(ROLE_IDS.inactive);
    await expectWarningWithoutMember();
  });

  it('ruolo speciale su chi non è membro', async () => {
    roles(MEMBER).add(ROLE_IDS.verified);
    roles(MEMBER).add(ROLE_IDS.shooter);
    await expectWarningWithoutMember();
  });

  it('produce un ROLE_SYNC_WARNING che elenca i ruoli toccati', async () => {
    roles(MEMBER).add(ROLE_IDS.ttp);
    roles(MEMBER).add(ROLE_IDS.resident);
    await cron.run();

    const warning = h.store.audit.find(
      (entry) => entry.action === AuditAction.ROLE_SYNC_WARNING && entry.targetDiscordId === MEMBER,
    );
    expect(warning?.reason).toContain('TTP');
    expect(warning?.metadata).toMatchObject({ autoCorrected: false, importable: false });
    expect(JSON.stringify(warning?.metadata)).toContain('TTP');
  });
});

describe('sbarramenti autorevoli a database', () => {
  it('un blacklistato con Verified non ottiene nessuna verifica', async () => {
    addFakeMember(h.guild, MEMBER);
    await cron.run();

    // Scritto direttamente sul repository: il service revocherebbe Verified,
    // e qui serve proprio lo stato incoerente.
    await h.repos.blacklist.add({
      discordId: MEMBER,
      reason: 'Tradimento',
      createdByDiscordId: OG,
    });
    roles(MEMBER).add(ROLE_IDS.verified);

    const report = await cron.run();

    expect(report.blocked).toBe(1);
    expect(report.imports).toBe(0);
    expect(await h.repos.verifications.findActive(MEMBER)).toBeNull();
  });

  it('Permadeath insieme a TTP non importa nulla', async () => {
    addFakeMember(h.guild, MEMBER);
    await verifyUser(h, MEMBER);
    await cron.run();

    roles(MEMBER).add(ROLE_IDS.ttp);
    roles(MEMBER).add(ROLE_IDS.resident);
    roles(MEMBER).add(ROLE_IDS.permadeath);

    const report = await cron.run();

    expect(report.blocked).toBe(1);
    expect(await h.repos.members.findByDiscordId(MEMBER)).toBeNull();
  });

  it('un membro PERMADEATH non viene riattivato assegnandogli dei ruoli', async () => {
    await createMemberViaCommand(MemberRank.LOC);
    await h.members.permadeath({
      discordId: MEMBER,
      actorDiscordId: OG,
      reason: 'morte definitiva',
    });
    await cron.run();

    // Qualcuno prova a rimetterlo dentro dalla UI di Discord.
    roles(MEMBER).delete(ROLE_IDS.permadeath);
    roles(MEMBER).add(ROLE_IDS.ttp);
    roles(MEMBER).add(ROLE_IDS.resident);

    const report = await cron.run();

    expect(report.blocked).toBe(1);
    expect((await h.repos.members.findByDiscordId(MEMBER))?.status).toBe(MemberStatus.PERMADEATH);
  });
});

describe('operazioni distruttive restano comando-only', () => {
  beforeEach(async () => {
    await createMemberViaCommand(MemberRank.LOC);
    await cron.run();
  });

  it('togliere TTP a mano NON imposta Member.status = LEFT', async () => {
    roles(MEMBER).delete(ROLE_IDS.ttp);
    const report = await cron.run();

    expect(report.warnings).toBe(1);
    const dbMember = await h.repos.members.findByDiscordId(MEMBER);
    expect(dbMember?.status).toBe(MemberStatus.ACTIVE);
    expect(dbMember?.leftTtpAt).toBeNull();
  });

  it('azzerare i rank NON toglie la membership', async () => {
    roles(MEMBER).delete(ROLE_IDS.loc);
    const report = await cron.run();

    expect(report.warnings).toBe(1);
    const dbMember = await h.repos.members.findByDiscordId(MEMBER);
    expect(dbMember?.status).toBe(MemberStatus.ACTIVE);
    expect(dbMember?.rank).toBe(MemberRank.LOC);
  });

  it('togliere Verified a un membro TTP NON revoca la verifica', async () => {
    roles(MEMBER).delete(ROLE_IDS.verified);
    const report = await cron.run();

    expect(report.warnings).toBe(1);
    expect(await h.repos.verifications.findActive(MEMBER)).not.toBeNull();
  });

  it('il ruolo Banned NON crea una blacklist senza motivazione né autore', async () => {
    roles(MEMBER).add(ROLE_IDS.banned);
    await cron.run();

    expect(await h.repos.blacklist.isBlacklisted(MEMBER)).toBe(false);
  });

  it('uscire dal Discord NON è lasciare la gang', async () => {
    const fake = h.guild.members.get(MEMBER);
    if (fake) fake.present = false;

    const report = await cron.run();

    expect(report.left).toBe(1);
    const dbMember = await h.repos.members.findByDiscordId(MEMBER);
    expect(dbMember?.status).toBe(MemberStatus.ACTIVE);
  });
});

// =============================================================================
// Idempotenza e assenza di loop fra comandi e cron
// =============================================================================

describe('idempotenza', () => {
  it('una seconda esecuzione non riapplica nulla', async () => {
    await createMemberViaCommand(MemberRank.TINY_LOC);
    await cron.run();

    roles(MEMBER).delete(ROLE_IDS.tinyLoc);
    roles(MEMBER).add(ROLE_IDS.og);
    await cron.run();

    const historyAfterFirst = h.store.history.length;
    const auditAfterFirst = h.store.audit.length;
    const announcementsAfterFirst = announcements().length;

    const second = await cron.run();

    expect(second.imports).toBe(0);
    expect(h.store.history.length).toBe(historyAfterFirst);
    expect(h.store.audit.length).toBe(auditAfterFirst);
    expect(announcements().length).toBe(announcementsAfterFirst);
  });

  it('una modifica fatta da comando è già allineata: il cron non la ripete', async () => {
    // Il comando scrive PRIMA il database e POI Discord. Al cron successivo
    // l'hash dei ruoli risulta cambiato, ma il database è già a posto: se il
    // cron non se ne accorgesse produrrebbe uno storico e un annuncio doppi.
    await createMemberViaCommand(MemberRank.TINY_LOC);
    await cron.run();

    await h.members.setRank({
      discordId: MEMBER,
      actorDiscordId: OG,
      rank: MemberRank.LOC,
      reason: 'promozione da comando',
    });

    const historyAfterCommand = h.store.history.length;
    const auditAfterCommand = h.store.audit.length;
    expect(announcements()).toHaveLength(1);

    const report = await cron.run();

    expect(report.imports).toBe(0);
    expect(report.warnings).toBe(0);
    expect(h.store.history.length).toBe(historyAfterCommand);
    expect(h.store.audit.length).toBe(auditAfterCommand);
    // Nessun secondo Put On per la stessa promozione.
    expect(announcements()).toHaveLength(1);
  });

  it('nessun annuncio duplicato al cron successivo a un import', async () => {
    await createMemberViaCommand(MemberRank.TINY_LOC);
    await cron.run();

    roles(MEMBER).delete(ROLE_IDS.tinyLoc);
    roles(MEMBER).add(ROLE_IDS.og);
    await cron.run();
    expect(announcements()).toHaveLength(1);

    await cron.run();
    await cron.run();
    expect(announcements()).toHaveLength(1);
  });
});

// =============================================================================
// Bootstrap: adozione dei ruoli già presenti prima del deploy
// =============================================================================

describe('bootstrap iniziale', () => {
  beforeEach(() => {
    // L'OG della fixture è a sua volta uno stato TTP valido e verrebbe adottato:
    // lo si toglie perché i conteggi parlino solo dei membri sotto esame.
    h.guild.members.delete(OG);

    // Guild già popolata, database vuoto: è lo stato al primo deploy.
    addFakeMember(h.guild, MEMBER, {
      roles: [ROLE_IDS.verified, ROLE_IDS.ttp, ROLE_IDS.loc, ROLE_IDS.shooter],
      position: 5,
    });
    addFakeMember(h.guild, OTHER, { roles: [ROLE_IDS.verified], position: 2 });
  });

  it('importa i ruoli già assegnati', async () => {
    const report = await cron.run();

    expect(report.seeded).toBe(true);
    expect(report.membersCreated).toBe(1);

    const dbMember = await h.repos.members.findByDiscordId(MEMBER);
    expect(dbMember?.rank).toBe(MemberRank.LOC);
    expect(await h.members.listSpecialRoles(dbMember?.id ?? '')).toEqual([SpecialRole.SHOOTER]);
    expect(await h.repos.verifications.findActive(OTHER)).not.toBeNull();
  });

  it('NON emette falsi eventi di join né messaggi di benvenuto', async () => {
    const report = await cron.run();

    expect(report.joined).toBe(0);
    expect(h.store.audit.some((e) => e.action === AuditAction.MEMBER_JOINED_DISCORD)).toBe(false);
  });

  it('NON pubblica Put On / Put Off', async () => {
    await cron.run();
    expect(announcements()).toHaveLength(0);
  });

  it('registra un audit aggregato con source discord_bootstrap', async () => {
    await cron.run();

    const entry = h.store.audit.find((e) => e.action === AuditAction.ROLE_SYNC_BOOTSTRAP);
    expect(entry?.actorDiscordId).toBeNull();
    expect(entry?.metadata).toMatchObject({ source: 'discord_bootstrap', membersCreated: 1 });
  });

  it('lascia invariati gli stati ambigui', async () => {
    addFakeMember(h.guild, '400000000000000003', {
      roles: [ROLE_IDS.ttp, ROLE_IDS.resident], // TTP senza Verified
    });

    const report = await cron.run();

    expect(report.warnings).toBeGreaterThan(0);
    expect(await h.repos.members.findByDiscordId('400000000000000003')).toBeNull();
  });

  it('funziona su una guild mista, con alcuni record già presenti', async () => {
    // `OTHER` ha già la verifica a database; `MEMBER` no.
    await verifyUser(h, OTHER);
    h.store.snapshots.clear();

    const verificationBefore = await h.repos.verifications.findActive(OTHER);
    const report = await cron.run();

    expect(report.membersCreated).toBe(1);
    // Una sola verifica importata: quella che MEMBER non aveva. Quella di
    // OTHER esisteva già e non viene ricreata né sovrascritta.
    expect(report.verificationsImported).toBe(1);
    const verificationAfter = await h.repos.verifications.findActive(OTHER);
    expect(verificationAfter?.id).toBe(verificationBefore?.id);
    expect(verificationAfter?.rpName).toBe(verificationBefore?.rpName);
  });

  it('in REPORT_ONLY si limita a fotografare, come prima', async () => {
    const reportOnly = build('REPORT_ONLY');
    const report = await reportOnly.run();

    expect(report.seeded).toBe(true);
    expect(report.imports).toBe(0);
    expect(await h.repos.members.findByDiscordId(MEMBER)).toBeNull();
  });

  it('il cron successivo non ritratta ciò che il bootstrap ha già importato', async () => {
    await cron.run();
    const historyAfterBootstrap = h.store.history.length;

    const second = await cron.run();

    expect(second.imports).toBe(0);
    expect(second.warnings).toBe(0);
    expect(h.store.history.length).toBe(historyAfterBootstrap);
  });
});

// =============================================================================
// REPORT_ONLY: le stesse regole, raccontate invece che applicate
// =============================================================================

describe('REPORT_ONLY', () => {
  it('segnala la divergenza importabile senza scrivere nulla', async () => {
    const reportOnly = build('REPORT_ONLY');
    await createMemberViaCommand(MemberRank.TINY_LOC);
    await reportOnly.run();

    roles(MEMBER).delete(ROLE_IDS.tinyLoc);
    roles(MEMBER).add(ROLE_IDS.og);
    const report = await reportOnly.run();

    expect(report.warnings).toBe(1);
    expect(report.imports).toBe(0);
    expect((await h.repos.members.findByDiscordId(MEMBER))?.rank).toBe(MemberRank.TINY_LOC);
    expect(announcements()).toHaveLength(0);

    const warning = h.store.audit.find((e) => e.action === AuditAction.ROLE_SYNC_WARNING);
    expect(warning?.metadata).toMatchObject({ importable: true, mode: 'REPORT_ONLY' });
  });
});
