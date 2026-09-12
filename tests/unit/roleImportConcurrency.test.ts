/**
 * Concorrenza e resistenza ai guasti dell'import dei ruoli.
 *
 * Il contesto che rende questi casi reali: `memberMutex` vive nella memoria di
 * UN isolate Cloudflare. Due invocazioni del Worker — un cron e un comando, o
 * due cron sovrapposti — non condividono quel lock, quindi l'unica difesa vera
 * è il database: `Member.version` per le mutazioni e i vincoli unique per le
 * creazioni.
 *
 * La regola che tiene insieme tutto: un fallimento NON deve far avanzare lo
 * snapshot del membro, così il cron successivo riprova. Uno stato già
 * allineato da altri invece non è un fallimento, e non va ri-storicizzato.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  AuditAction,
  MemberHistoryEvent,
  MemberRank,
  MemberStatus,
  SpecialRole,
} from '../../src/generated/prisma/enums.js';
import { isUniqueViolation } from '../../src/repositories/uniqueViolation.js';
import {
  createMemberReconciliationService,
  type MemberReconciliationService,
} from '../../src/services/memberReconciliationService.js';
import type { Member } from '../../src/repositories/types.js';
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

function build(): MemberReconciliationService {
  return createMemberReconciliationService({
    repos: h.repos,
    roleRegistry: h.roles,
    audit: h.audit,
    blacklist: h.blacklist,
    roleImport: h.roleImport,
    mode: 'IMPORT_SAFE',
    listAllGuildMembers: () => Promise.resolve(snapshots()),
    guildId: GUILD_ID,
  });
}

function roles(discordId: string): Set<string> {
  return fakeMember(discordId).roles;
}

/** Il membro finto, con un errore esplicito se il test lo ha dimenticato. */
function fakeMember(discordId: string) {
  const member = h.guild.members.get(discordId);
  if (!member) throw new Error(`Membro finto ${discordId} inesistente`);
  return member;
}

function snapshotRow(discordId: string) {
  return h.repos.snapshots
    .listForGuild(GUILD_ID)
    .then((rows) => rows.find((row) => row.discordId === discordId));
}

/** Le righe `Member` esistenti per un Discord ID: ne deve restare sempre una. */
function membersFor(discordId: string): Member[] {
  return [...h.store.members.values()].filter((member) => member.discordId === discordId);
}

function historyEvents(discordId: string): MemberHistoryEvent[] {
  return h.store.history.filter((e) => e.discordId === discordId).map((e) => e.event);
}

function announcements() {
  return h.guild.messages.filter((message) => message.channelId === CHANNEL_IDS.putOnOff);
}

async function createMemberViaCommand(rank: MemberRank = MemberRank.TINY_LOC): Promise<void> {
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

describe('riconoscimento delle violazioni di vincolo univoco', () => {
  it('riconosce il codice Prisma P2002', () => {
    expect(isUniqueViolation({ code: 'P2002' })).toBe(true);
  });

  it('riconosce il messaggio dei doppi in memoria', () => {
    expect(
      isUniqueViolation(new Error('Unique constraint failed on the fields: (`discordId`)')),
    ).toBe(true);
  });

  it('NON scambia un errore qualsiasi per una violazione attesa', () => {
    // È la distinzione che conta: trasformare un guasto vero in un `null`
    // silenzioso nasconderebbe un problema invece di gestirlo.
    expect(isUniqueViolation(new Error('connection terminated unexpectedly'))).toBe(false);
    expect(isUniqueViolation({ code: 'P1001' })).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation('P2002')).toBe(false);
  });
});

describe('conflitto su Member.version', () => {
  beforeEach(async () => {
    await createMemberViaCommand();
    await cron.run(); // seed
    roles(MEMBER).delete(ROLE_IDS.tinyLoc);
    roles(MEMBER).add(ROLE_IDS.og);
  });

  it('un conflitto NON risolvibile non fa avanzare lo snapshot', async () => {
    // Il locking rifiuta la scrittura e lo stato NON è quello desiderato:
    // applicare comunque significherebbe sovrascrivere la modifica di un altro.
    const original = h.repos.members.updateWithVersion.bind(h.repos.members);
    h.repos.members.updateWithVersion = () => Promise.resolve(null);

    const report = await cron.run();

    expect(report.failures).toBe(1);
    expect(report.imports).toBe(0);

    h.repos.members.updateWithVersion = original;

    // Snapshot fermo al valore precedente: il cron successivo riprova.
    const row = await snapshotRow(MEMBER);
    expect(row?.roleIds).toContain(ROLE_IDS.tinyLoc);
    expect(row?.roleIds).not.toContain(ROLE_IDS.og);

    const recovered = await cron.run();
    expect(recovered.ranksUpdated).toBe(1);
    expect((await h.repos.members.findByDiscordId(MEMBER))?.rank).toBe(MemberRank.OG);
  });

  it('una transizione GIÀ applicata da altri non viene ripetuta', async () => {
    // Il locking rifiuta, ma rileggendo si scopre che il risultato voluto c'è
    // già: l'operazione è completa, e ri-storicizzarla creerebbe un doppione.
    const original = h.repos.members.updateWithVersion.bind(h.repos.members);
    h.repos.members.updateWithVersion = async (id, expectedVersion, patch) => {
      // Applica la modifica come farebbe l'altra esecuzione, poi finge il
      // conflitto di versione che quell'esecuzione avrebbe causato.
      await original(id, expectedVersion, patch);
      return null;
    };

    const report = await cron.run();

    expect(report.failures).toBe(0);
    expect(report.imports).toBe(0);
    expect((await h.repos.members.findByDiscordId(MEMBER))?.rank).toBe(MemberRank.OG);
    // Nessuno storico e nessun annuncio: li ha già scritti chi ha vinto la gara.
    expect(historyEvents(MEMBER)).not.toContain(MemberHistoryEvent.PROMOTED);
    expect(announcements()).toHaveLength(0);
  });

  it('due import concorrenti sullo stesso membro applicano UNA sola transizione', async () => {
    const snapshot = snapshotOf(fakeMember(MEMBER));

    await Promise.all([
      h.roleImport.importMember({ snapshot }),
      h.roleImport.importMember({ snapshot }),
    ]);

    expect((await h.repos.members.findByDiscordId(MEMBER))?.rank).toBe(MemberRank.OG);
    expect(historyEvents(MEMBER).filter((e) => e === MemberHistoryEvent.PROMOTED)).toHaveLength(1);
    expect(announcements()).toHaveLength(1);
  });
});

describe('creazione concorrente del membro', () => {
  beforeEach(async () => {
    addFakeMember(h.guild, MEMBER, { position: 1 });
    await verifyUser(h, MEMBER);
    await cron.run(); // seed
    roles(MEMBER).add(ROLE_IDS.ttp);
    roles(MEMBER).add(ROLE_IDS.resident);
  });

  it('una unique violation attesa non diventa un errore permanente', async () => {
    // Qualcun altro crea la riga fra il calcolo del piano e la scrittura.
    const original = h.repos.members.create.bind(h.repos.members);
    let intercepted = false;
    h.repos.members.create = async (input) => {
      if (!intercepted) {
        intercepted = true;
        await original(input); // l'altra esecuzione vince la gara
        throw new Error('Unique constraint failed on the fields: (`discordId`)');
      }
      return original(input);
    };

    const report = await cron.run();

    expect(report.failures).toBe(0);
    // Una sola riga per questo Discord ID: il vincolo ha fatto il suo lavoro.
    expect(membersFor(MEMBER)).toHaveLength(1);
    expect((await h.repos.members.findByDiscordId(MEMBER))?.rank).toBe(MemberRank.RESIDENT);
    // Questa esecuzione NON storicizza l'ingresso: non è stata lei a farlo
    // entrare, e scrivere comunque un JOINED_TTP creerebbe il doppione che il
    // vincolo unique è servito a evitare. (Lo stub simula solo l'inserimento
    // della riga da parte dell'altra esecuzione, non la sua scrittura dello
    // storico: il caso completo è il test qui sotto, con due import reali.)
    expect(historyEvents(MEMBER).filter((e) => e === MemberHistoryEvent.JOINED_TTP)).toHaveLength(
      0,
    );
  });

  it('due import concorrenti creano UN solo membro', async () => {
    const snapshot = snapshotOf(fakeMember(MEMBER));

    await Promise.all([
      h.roleImport.importMember({ snapshot }),
      h.roleImport.importMember({ snapshot }),
    ]);

    expect(membersFor(MEMBER)).toHaveLength(1);
    expect(historyEvents(MEMBER).filter((e) => e === MemberHistoryEvent.JOINED_TTP)).toHaveLength(
      1,
    );
  });

  it('un errore di database VERO non viene scambiato per una gara persa', async () => {
    h.repos.members.create = () => Promise.reject(new Error('connection terminated unexpectedly'));

    const report = await cron.run();

    expect(report.failures).toBe(1);
    // Snapshot non avanzato: al prossimo cron si riprova.
    const row = await snapshotRow(MEMBER);
    expect(row?.roleIds).not.toContain(ROLE_IDS.ttp);
  });
});

describe('conflitto su un ruolo speciale', () => {
  beforeEach(async () => {
    await createMemberViaCommand();
    await cron.run();
    roles(MEMBER).add(ROLE_IDS.shooter);
  });

  it('due import concorrenti producono UNA sola assegnazione attiva', async () => {
    const snapshot = snapshotOf(fakeMember(MEMBER));

    await Promise.all([
      h.roleImport.importMember({ snapshot }),
      h.roleImport.importMember({ snapshot }),
    ]);

    const dbMember = await h.repos.members.findByDiscordId(MEMBER);
    expect(await h.members.listSpecialRoles(dbMember?.id ?? '')).toEqual([SpecialRole.SHOOTER]);
    expect(
      historyEvents(MEMBER).filter((e) => e === MemberHistoryEvent.SPECIAL_ROLE_ADDED),
    ).toHaveLength(1);
  });

  it('un ruolo già attivo a database non viene ri-storicizzato', async () => {
    await cron.run();
    const before = h.store.history.length;

    // Stesso stato, nuova esecuzione: niente da fare.
    await h.roleImport.importMember({ snapshot: snapshotOf(fakeMember(MEMBER)) });

    expect(h.store.history.length).toBe(before);
  });
});

describe('isolamento dei guasti', () => {
  it('un errore su un membro non ferma gli altri', async () => {
    addFakeMember(h.guild, MEMBER, { position: 1 });
    addFakeMember(h.guild, OTHER, { position: 1 });
    await verifyUser(h, MEMBER);
    await verifyUser(h, OTHER);
    await cron.run(); // seed

    roles(MEMBER).add(ROLE_IDS.ttp);
    roles(MEMBER).add(ROLE_IDS.resident);
    roles(OTHER).add(ROLE_IDS.ttp);
    roles(OTHER).add(ROLE_IDS.resident);

    const original = h.repos.members.create.bind(h.repos.members);
    h.repos.members.create = (input) =>
      input.discordId === MEMBER ? Promise.reject(new Error('errore isolato')) : original(input);

    const report = await cron.run();

    expect(report.failures).toBe(1);
    expect(report.membersCreated).toBe(1);
    expect(await h.repos.members.findByDiscordId(OTHER)).not.toBeNull();
    expect(await h.repos.members.findByDiscordId(MEMBER)).toBeNull();

    // Solo lo snapshot del membro fallito resta indietro.
    expect((await snapshotRow(OTHER))?.roleIds).toContain(ROLE_IDS.ttp);
    expect((await snapshotRow(MEMBER))?.roleIds).not.toContain(ROLE_IDS.ttp);
  });

  it('uno stato AMBIGUO fa avanzare lo snapshot: non è un guasto', async () => {
    // Altrimenti la stessa segnalazione tornerebbe a ogni cron, per sempre.
    // Resta comunque visibile in `/system sync-check` finché non si corregge.
    addFakeMember(h.guild, MEMBER, { position: 1 });
    await cron.run();

    roles(MEMBER).add(ROLE_IDS.ttp);
    roles(MEMBER).add(ROLE_IDS.resident); // TTP senza Verified

    const first = await cron.run();
    expect(first.warnings).toBe(1);
    expect(first.failures).toBe(0);
    expect((await snapshotRow(MEMBER))?.roleIds).toContain(ROLE_IDS.ttp);

    // Nessuna ripetizione del warning finché i ruoli non cambiano ancora.
    const second = await cron.run();
    expect(second.warnings).toBe(0);

    // Ma la divergenza resta visibile alla diagnostica.
    const report = await h.consistency.run();
    expect(report.issues.some((issue) => issue.discordId === MEMBER)).toBe(true);
  });

  it('un errore nell’annuncio Put On NON annulla l’import', async () => {
    await createMemberViaCommand();
    await cron.run();

    h.guild.failMessages = true;
    roles(MEMBER).delete(ROLE_IDS.tinyLoc);
    roles(MEMBER).add(ROLE_IDS.og);

    const report = await cron.run();

    expect(report.failures).toBe(0);
    expect(report.ranksUpdated).toBe(1);
    // Il rank è cambiato e lo storico c'è: l'annuncio non è il dato autorevole.
    expect((await h.repos.members.findByDiscordId(MEMBER))?.rank).toBe(MemberRank.OG);
    expect(historyEvents(MEMBER)).toContain(MemberHistoryEvent.PROMOTED);
    expect(announcements()).toHaveLength(0);

    // E lo snapshot è avanzato: nessun secondo tentativo di annuncio.
    h.guild.failMessages = false;
    const again = await cron.run();
    expect(again.imports).toBe(0);
    expect(announcements()).toHaveLength(0);
  });

  it('un errore nello storico non fa avanzare lo snapshot', async () => {
    await createMemberViaCommand();
    await cron.run();

    const original = h.repos.history.record.bind(h.repos.history);
    let failed = false;
    h.repos.history.record = (input) => {
      if (!failed) {
        failed = true;
        return Promise.reject(new Error('database non raggiungibile'));
      }
      return original(input);
    };

    roles(MEMBER).add(ROLE_IDS.inactive);
    const report = await cron.run();

    expect(report.failures).toBe(1);
    expect((await snapshotRow(MEMBER))?.roleIds).not.toContain(ROLE_IDS.inactive);

    // Il cron successivo riprende in mano il membro invece di darlo per fatto.
    const recovered = await cron.run();
    expect(recovered.failures).toBe(0);

    // Lo stato converge comunque su quello di Discord, che è il punto.
    //
    // NOTA: qui la transizione risulta `unchanged` perché `Member.status` era
    // già stato scritto prima che lo storico fallisse — la riga di
    // MemberHistory di QUELLA transizione è persa. È il compromesso che tutto
    // il progetto adotta (`MemberService` incluso): scrivere lo stato prima
    // dello storico. L'ordine opposto lascerebbe uno storico che racconta una
    // modifica mai avvenuta, che è la bugia peggiore fra le due.
    expect(recovered.statusesUpdated).toBe(0);
    expect((await h.repos.members.findByDiscordId(MEMBER))?.status).toBe(MemberStatus.INACTIVE);
  });

  it('un audit non consegnato su Discord non annulla l’import', async () => {
    // L'audit a database è parte dell'operazione; la copia su Discord no.
    await createMemberViaCommand();
    await cron.run();

    roles(MEMBER).add(ROLE_IDS.inactive);
    const report = await cron.run();

    expect(report.statusesUpdated).toBe(1);
    expect(
      h.store.audit.some(
        (entry) => entry.action === AuditAction.SET_INACTIVE && entry.targetDiscordId === MEMBER,
      ),
    ).toBe(true);
  });
});

describe('nessun loop fra comando e cron', () => {
  it('un ciclo comando → cron → cron non produce scritture aggiuntive', async () => {
    await createMemberViaCommand();
    await cron.run();

    await h.members.promote({ discordId: MEMBER, actorDiscordId: OG, reason: 'promozione' });
    const afterCommand: Member | null = await h.repos.members.findByDiscordId(MEMBER);
    const versionAfterCommand = afterCommand?.version ?? -1;

    await cron.run();
    await cron.run();

    const afterCron = await h.repos.members.findByDiscordId(MEMBER);
    // `Member.version` non si muove: nessuna scrittura inutile.
    expect(afterCron?.version).toBe(versionAfterCommand);
    expect(announcements()).toHaveLength(1);
  });
});
