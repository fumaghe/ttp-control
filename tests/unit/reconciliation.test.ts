/**
 * Riconciliazione periodica (Cron Trigger).
 *
 * Sostituisce i tre eventi Gateway della V1. Questi test verificano che le
 * REGOLE DI DOMINIO restino identiche: uscire dal Discord non è lasciare la
 * gang, una modifica manuale dei ruoli si segnala ma non si corregge, la
 * blacklist a database resta autorevole al rientro.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { AuditAction, MemberStatus } from '../../src/generated/prisma/enums.js';
import {
  createMemberReconciliationService,
  hashRoleIds,
  type MemberReconciliationService,
} from '../../src/services/memberReconciliationService.js';
import type { GuildMemberSnapshot } from '../../src/services/roleGateway.js';
import {
  addFakeMember,
  createHarness,
  GUILD_ID,
  ROLE_IDS,
  verifyUser,
} from '../support/harness.js';
import type { Harness } from '../support/harness.js';

const ACTOR = '400000000000000000';
const MEMBER = '400000000000000001';

let harness: Harness;
let service: MemberReconciliationService;

function snapshots(): GuildMemberSnapshot[] {
  return [...harness.guild.members.values()]
    .filter((member) => member.present)
    .map((member) => ({
      discordId: member.discordId,
      username: member.username,
      displayName: member.displayName,
      roleIds: new Set(member.roles),
      highestRolePosition: member.highestRolePosition,
      isGuildOwner: member.isGuildOwner,
    }));
}

function build(options: { listAllGuildMembers?: () => Promise<GuildMemberSnapshot[]> } = {}) {
  return createMemberReconciliationService({
    repos: harness.repos,
    roles: harness.roleService,
    roleRegistry: harness.roles,
    audit: harness.audit,
    blacklist: harness.blacklist,
    listAllGuildMembers: options.listAllGuildMembers ?? (() => Promise.resolve(snapshots())),
    guildId: GUILD_ID,
  });
}

function auditActions(): AuditAction[] {
  return harness.store.audit.map((entry) => entry.action);
}

beforeEach(() => {
  harness = createHarness();
  service = build();
});

describe('impronta dei ruoli', () => {
  it('è indipendente dall’ordine', () => {
    expect(hashRoleIds(['a', 'b', 'c'])).toBe(hashRoleIds(['c', 'a', 'b']));
  });

  it('distingue insiemi diversi, anche con confini ambigui', () => {
    expect(hashRoleIds(['1', '23'])).not.toBe(hashRoleIds(['12', '3']));
    expect(hashRoleIds(['a'])).not.toBe(hashRoleIds(['a', 'b']));
  });
});

describe('prima esecuzione', () => {
  it('fotografa la guild senza emettere eventi di join', async () => {
    // Senza questo, il primo cron su una guild già popolata inonderebbe
    // l'audit con un MEMBER_JOINED_DISCORD per ogni membro esistente.
    addFakeMember(harness.guild, MEMBER, { roles: [ROLE_IDS.verified] });
    addFakeMember(harness.guild, '400000000000000002');

    const report = await service.run();

    expect(report.seeded).toBe(true);
    expect(report.joined).toBe(0);
    expect(auditActions()).not.toContain(AuditAction.MEMBER_JOINED_DISCORD);
    expect(await harness.repos.snapshots.countForGuild(GUILD_ID)).toBe(2);
  });
});

describe('rilevamento dei nuovi membri (sostituisce guildMemberAdd)', () => {
  it('registra JOIN, anagrafica e audit alla comparsa di un nuovo Discord ID', async () => {
    addFakeMember(harness.guild, ACTOR);
    await service.run(); // seed

    addFakeMember(harness.guild, MEMBER, { displayName: 'Tony' });
    const report = await service.run();

    expect(report.joined).toBe(1);
    expect(auditActions()).toContain(AuditAction.MEMBER_JOINED_DISCORD);

    const profile = await harness.repos.profiles.findByDiscordId(MEMBER);
    expect(profile).not.toBeNull();
  });

  it('non assegna nessun ruolo: la verifica resta un atto volontario', async () => {
    addFakeMember(harness.guild, ACTOR);
    await service.run();

    addFakeMember(harness.guild, MEMBER);
    await service.run();

    expect(harness.guild.members.get(MEMBER)?.roles.size).toBe(0);
  });

  it('riconosce un rientro dopo un’uscita registrata', async () => {
    const member = addFakeMember(harness.guild, MEMBER);
    await service.run();

    member.present = false;
    await service.run();

    member.present = true;
    const report = await service.run();

    expect(report.joined).toBe(1);
  });
});

describe('rientro di un utente in blacklist', () => {
  it('segnala il rientro senza restituire l’accesso', async () => {
    // La blacklist è autorevole a DATABASE: uscire e rientrare non la aggira.
    addFakeMember(harness.guild, ACTOR, {
      roles: [ROLE_IDS.verified, ROLE_IDS.ttp, ROLE_IDS.og],
      position: 10,
    });
    await service.run();

    await harness.blacklist.add({
      discordId: MEMBER,
      reason: 'Comportamento tossico',
      actorDiscordId: ACTOR,
    });

    addFakeMember(harness.guild, MEMBER);
    const report = await service.run();

    expect(report.blacklistedRejoins).toBe(1);
    expect(auditActions()).toContain(AuditAction.BLACKLISTED_USER_REJOINED);

    // Nessun Verified restituito, nessun ban automatico: la policy di
    // default non prevede azioni distruttive.
    expect(harness.guild.members.get(MEMBER)?.roles.has(ROLE_IDS.verified)).toBe(false);
  });
});

describe('rilevamento delle uscite (sostituisce guildMemberRemove)', () => {
  it('registra MEMBER_LEFT_DISCORD e marca lo snapshot', async () => {
    const member = addFakeMember(harness.guild, MEMBER);
    await service.run();

    member.present = false;
    const report = await service.run();

    expect(report.left).toBe(1);
    expect(auditActions()).toContain(AuditAction.MEMBER_LEFT_DISCORD);

    const rows = await harness.repos.snapshots.listForGuild(GUILD_ID);
    expect(rows.find((row) => row.discordId === MEMBER)?.inGuild).toBe(false);
  });

  it('un membro TTP che esce NON viene rimosso dalla gang', async () => {
    // Uscire dal Discord e lasciare la gang sono due cose diverse. Il bot
    // avvisa e basta: la decisione è della Leadership.
    addFakeMember(harness.guild, ACTOR, {
      roles: [ROLE_IDS.verified, ROLE_IDS.ttp, ROLE_IDS.og],
      position: 10,
    });
    const member = addFakeMember(harness.guild, MEMBER, { position: 1 });
    await verifyUser(harness, MEMBER);
    await harness.members.addToGang({
      discordId: MEMBER,
      actorDiscordId: ACTOR,
      rank: 'RESIDENT',
      reason: 'ingresso',
      source: 'manual',
    });
    await service.run();

    member.present = false;
    const report = await service.run();

    expect(report.warnings).toBe(1);
    expect(auditActions()).toContain(AuditAction.ROLE_SYNC_WARNING);

    const dbMember = await harness.repos.members.findByDiscordId(MEMBER);
    expect(dbMember?.status).toBe(MemberStatus.ACTIVE);
    expect(dbMember?.leftTtpAt).toBeNull();
  });

  it('non segnala due volte la stessa uscita', async () => {
    const member = addFakeMember(harness.guild, MEMBER);
    await service.run();

    member.present = false;
    await service.run();
    const before = harness.store.audit.length;

    await service.run();
    expect(harness.store.audit.length).toBe(before);
  });
});

describe('modifiche manuali dei ruoli (sostituisce guildMemberUpdate)', () => {
  it('segnala la divergenza ma NON corregge nulla', async () => {
    addFakeMember(harness.guild, ACTOR, {
      roles: [ROLE_IDS.verified, ROLE_IDS.ttp, ROLE_IDS.og],
      position: 10,
    });
    addFakeMember(harness.guild, MEMBER, { position: 1 });
    await verifyUser(harness, MEMBER);
    await harness.members.addToGang({
      discordId: MEMBER,
      actorDiscordId: ACTOR,
      rank: 'RESIDENT',
      reason: 'ingresso',
      source: 'manual',
    });
    await service.run();

    // Qualcuno toglie TTP a mano dalla UI di Discord.
    harness.guild.members.get(MEMBER)?.roles.delete(ROLE_IDS.ttp);
    const report = await service.run();

    expect(report.roleChanges).toBe(1);
    expect(report.warnings).toBe(1);

    const warning = harness.store.audit.find(
      (entry) => entry.action === AuditAction.ROLE_SYNC_WARNING,
    );
    expect(warning?.reason).toContain('non ha più il ruolo TTP');
    expect(warning?.metadata).toMatchObject({ autoCorrected: false });

    // Il ruolo NON è stato riassegnato: nessuna sincronizzazione distruttiva.
    expect(harness.guild.members.get(MEMBER)?.roles.has(ROLE_IDS.ttp)).toBe(false);
  });

  it('rileva più rank contemporanei', async () => {
    addFakeMember(harness.guild, ACTOR, {
      roles: [ROLE_IDS.verified, ROLE_IDS.ttp, ROLE_IDS.og],
      position: 10,
    });
    addFakeMember(harness.guild, MEMBER, { position: 1 });
    await verifyUser(harness, MEMBER);
    await harness.members.addToGang({
      discordId: MEMBER,
      actorDiscordId: ACTOR,
      rank: 'RESIDENT',
      reason: 'ingresso',
      source: 'manual',
    });
    await service.run();

    harness.guild.members.get(MEMBER)?.roles.add(ROLE_IDS.big);
    await service.run();

    const warning = harness.store.audit.find(
      (entry) => entry.action === AuditAction.ROLE_SYNC_WARNING,
    );
    expect(warning?.reason).toContain('2 rank contemporaneamente');
  });

  it('ignora i ruoli che il bot non gestisce', async () => {
    addFakeMember(harness.guild, MEMBER);
    await service.run();

    harness.guild.members.get(MEMBER)?.roles.add('299999999999999999');
    const report = await service.run();

    expect(report.roleChanges).toBe(1);
    expect(report.warnings).toBe(0);
  });
});

describe('idempotenza e resistenza ai guasti', () => {
  it('una seconda esecuzione senza cambiamenti non produce eventi', async () => {
    addFakeMember(harness.guild, MEMBER, { roles: [ROLE_IDS.verified] });
    await service.run();
    const afterSeed = harness.store.audit.length;

    const report = await service.run();

    expect(report.joined).toBe(0);
    expect(report.left).toBe(0);
    expect(report.roleChanges).toBe(0);
    expect(harness.store.audit.length).toBe(afterSeed);
  });

  it('un membro che fallisce NON avanza lo snapshot: il cron successivo riprova', async () => {
    // È ciò che rende sicuro ripetere il cron: uno stato avanzato per
    // qualcosa che non è stato fatto sarebbe una corruzione silenziosa.
    addFakeMember(harness.guild, ACTOR);
    await service.run();

    addFakeMember(harness.guild, MEMBER);

    const broken = harness.repos.profiles.upsert.bind(harness.repos.profiles);
    let failures = 0;
    harness.repos.profiles.upsert = (identity) => {
      if (identity.discordId === MEMBER && failures === 0) {
        failures += 1;
        return Promise.reject(new Error('database non raggiungibile'));
      }
      return broken(identity);
    };

    const failed = await service.run();
    expect(failed.failures).toBe(1);

    const rows = await harness.repos.snapshots.listForGuild(GUILD_ID);
    expect(rows.some((row) => row.discordId === MEMBER)).toBe(false);

    // Alla ripresa il JOIN viene trattato, non perso.
    const recovered = await service.run();
    expect(recovered.joined).toBe(1);
    expect(recovered.failures).toBe(0);
  });

  it('un errore su un membro non ferma gli altri', async () => {
    addFakeMember(harness.guild, ACTOR);
    await service.run();

    addFakeMember(harness.guild, MEMBER);
    addFakeMember(harness.guild, '400000000000000003');

    const original = harness.repos.profiles.upsert.bind(harness.repos.profiles);
    harness.repos.profiles.upsert = (identity) =>
      identity.discordId === MEMBER
        ? Promise.reject(new Error('errore isolato'))
        : original(identity);

    const report = await service.run();

    expect(report.failures).toBe(1);
    expect(report.joined).toBe(2);

    const rows = await harness.repos.snapshots.listForGuild(GUILD_ID);
    expect(rows.some((row) => row.discordId === '400000000000000003')).toBe(true);
  });

  it('un guasto nell’enumerazione Discord non tocca gli snapshot', async () => {
    addFakeMember(harness.guild, MEMBER);
    await service.run();

    const broken = build({
      listAllGuildMembers: () => Promise.reject(new Error('Discord non raggiungibile')),
    });

    await expect(broken.run()).rejects.toThrow();

    const rows = await harness.repos.snapshots.listForGuild(GUILD_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.inGuild).toBe(true);
  });
});
