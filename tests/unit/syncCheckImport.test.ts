/**
 * `/system sync-check` e l'import condividono le stesse regole.
 *
 * La proprietà che questi test difendono è quella che una seconda
 * implementazione delle invarianti farebbe saltare per prima: dopo un cron
 * riuscito in `IMPORT_SAFE`, ciò che è stato importato deve SMETTERE di
 * comparire nella diagnostica. Con due copie delle regole, prima o poi una
 * direbbe "divergente" e l'altra "importata", e nessuna delle due sarebbe
 * verificabile contro l'altra.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { MemberRank, MemberStatus } from '../../src/generated/prisma/enums.js';
import { createConsistencyService } from '../../src/services/consistencyService.js';
import {
  createMemberReconciliationService,
  type MemberReconciliationService,
} from '../../src/services/memberReconciliationService.js';
import type { GuildMemberSnapshot } from '../../src/services/roleGateway.js';
import {
  addFakeMember,
  createHarness,
  GUILD_ID,
  ROLE_IDS,
  snapshotOf,
  verifyUser,
  type Harness,
} from '../support/harness.js';

const OG = '400000000000000000';
const MEMBER = '400000000000000001';

let h: Harness;
let cron: MemberReconciliationService;

function snapshots(): GuildMemberSnapshot[] {
  return [...h.guild.members.values()].filter((member) => member.present).map(snapshotOf);
}

function syncCheck(mode: 'REPORT_ONLY' | 'IMPORT_SAFE') {
  return createConsistencyService({
    repos: h.repos,
    roleRegistry: h.roles,
    roleImport: h.roleImport,
    mode,
    listAllGuildMembers: () => Promise.resolve(snapshots()),
  });
}

function roles(discordId: string): Set<string> {
  const member = h.guild.members.get(discordId);
  if (!member) throw new Error(`Membro finto ${discordId} inesistente`);
  return member.roles;
}

beforeEach(() => {
  h = createHarness();
  cron = createMemberReconciliationService({
    repos: h.repos,
    roleRegistry: h.roles,
    audit: h.audit,
    blacklist: h.blacklist,
    roleImport: h.roleImport,
    mode: 'IMPORT_SAFE',
    listAllGuildMembers: () => Promise.resolve(snapshots()),
    guildId: GUILD_ID,
  });
});

describe('la diagnostica smette di segnalare ciò che il cron ha importato', () => {
  beforeEach(async () => {
    addFakeMember(h.guild, MEMBER, { position: 1 });
    await verifyUser(h, MEMBER);
    await h.members.addToGang({
      discordId: MEMBER,
      actorDiscordId: OG,
      rank: MemberRank.TINY_LOC,
      reason: 'ingresso',
      source: 'manual',
    });
    await cron.run(); // seed
  });

  it('un cambio di rank manuale sparisce dal report dopo il cron', async () => {
    roles(MEMBER).delete(ROLE_IDS.tinyLoc);
    roles(MEMBER).add(ROLE_IDS.og);

    const before = await syncCheck('IMPORT_SAFE').run();
    const mismatch = before.issues.find((issue) => issue.kind === 'RANK_MISMATCH');
    expect(mismatch).toBeDefined();
    // È importabile: il report lo dice, così l'operatore non interviene a mano.
    expect(mismatch?.importable).toBe(true);
    expect(before.importableIssues).toBeGreaterThan(0);

    await cron.run();

    const after = await syncCheck('IMPORT_SAFE').run();
    expect(after.issues.filter((issue) => issue.discordId === MEMBER)).toHaveLength(0);
  });

  it('un ruolo speciale aggiunto a mano sparisce dopo il cron', async () => {
    roles(MEMBER).add(ROLE_IDS.shooter);

    expect(
      (await syncCheck('IMPORT_SAFE').run()).issues.some(
        (issue) => issue.kind === 'SPECIAL_ROLE_MISMATCH',
      ),
    ).toBe(true);

    await cron.run();

    expect(
      (await syncCheck('IMPORT_SAFE').run()).issues.some(
        (issue) => issue.kind === 'SPECIAL_ROLE_MISMATCH',
      ),
    ).toBe(false);
  });
});

describe('distingue ciò che il cron risolve da ciò che richiede una persona', () => {
  beforeEach(async () => {
    addFakeMember(h.guild, MEMBER, { position: 1 });
    await verifyUser(h, MEMBER);
    await h.members.addToGang({
      discordId: MEMBER,
      actorDiscordId: OG,
      rank: MemberRank.LOC,
      reason: 'ingresso',
      source: 'manual',
    });
    await cron.run();
  });

  it('la rimozione manuale di TTP NON è importabile', async () => {
    roles(MEMBER).delete(ROLE_IDS.ttp);

    const report = await syncCheck('IMPORT_SAFE').run();
    const forMember = report.issues.filter((entry) => entry.discordId === MEMBER);

    // Togliere TTP lascia anche un rank orfano: entrambe le voci compaiono, e
    // NESSUNA delle due è importabile.
    expect(forMember.length).toBeGreaterThan(0);
    expect(forMember.every((entry) => !entry.importable)).toBe(true);

    const removal = forMember.find((entry) => entry.kind === 'MEMBER_DB_WITHOUT_TTP_ROLE');
    expect(removal?.suggestion).toContain('/member remove');

    // E resta segnalata anche dopo il cron: nessun automatismo la risolve.
    await cron.run();
    expect(
      (await syncCheck('IMPORT_SAFE').run()).issues.some((entry) => entry.discordId === MEMBER),
    ).toBe(true);
    expect((await h.repos.members.findByDiscordId(MEMBER))?.status).toBe(MemberStatus.ACTIVE);
  });

  it('due rank insieme NON sono importabili', async () => {
    roles(MEMBER).add(ROLE_IDS.og);

    const report = await syncCheck('IMPORT_SAFE').run();
    const issue = report.issues.find((entry) => entry.kind === 'MULTIPLE_RANKS');

    expect(issue?.importable).toBe(false);
    expect(issue?.severity).toBe('error');
  });

  it('un blacklistato con accesso NON è importabile', async () => {
    await h.repos.blacklist.add({
      discordId: MEMBER,
      reason: 'Tradimento',
      createdByDiscordId: OG,
    });

    const report = await syncCheck('IMPORT_SAFE').run();
    const issue = report.issues.find((entry) => entry.kind === 'BLACKLISTED_WITH_ACCESS');

    expect(issue?.importable).toBe(false);
    expect(issue?.suggestion).toContain('/community revoke');
  });
});

describe('il suggerimento dipende dalla modalità configurata', () => {
  beforeEach(async () => {
    addFakeMember(h.guild, MEMBER, { position: 1 });
    await verifyUser(h, MEMBER);
    await h.members.addToGang({
      discordId: MEMBER,
      actorDiscordId: OG,
      rank: MemberRank.TINY_LOC,
      reason: 'ingresso',
      source: 'manual',
    });
    await cron.run();
    roles(MEMBER).delete(ROLE_IDS.tinyLoc);
    roles(MEMBER).add(ROLE_IDS.og);
  });

  it('in IMPORT_SAFE dice di non fare nulla', async () => {
    const report = await syncCheck('IMPORT_SAFE').run();
    const issue = report.issues.find((entry) => entry.kind === 'RANK_MISMATCH');
    expect(issue?.suggestion).toContain('Nessun intervento necessario');
  });

  it('in REPORT_ONLY indica il comando da usare', async () => {
    const report = await syncCheck('REPORT_ONLY').run();
    const issue = report.issues.find((entry) => entry.kind === 'RANK_MISMATCH');
    expect(issue?.suggestion).toContain('/member rank');
  });

  it('rileva la stessa divergenza in entrambe le modalità', async () => {
    // La modalità cambia il consiglio, mai la diagnosi.
    const safe = await syncCheck('IMPORT_SAFE').run();
    const reportOnly = await syncCheck('REPORT_ONLY').run();

    expect(safe.issues.map((entry) => entry.kind)).toEqual(
      reportOnly.issues.map((entry) => entry.kind),
    );
  });
});

describe('la diagnostica non corregge mai nulla', () => {
  it('chiamarla non cambia né database né Discord, nemmeno in IMPORT_SAFE', async () => {
    addFakeMember(h.guild, MEMBER, { position: 1 });
    roles(MEMBER).add(ROLE_IDS.verified);
    roles(MEMBER).add(ROLE_IDS.ttp);
    roles(MEMBER).add(ROLE_IDS.resident);

    const rolesBefore = new Set(roles(MEMBER));

    await syncCheck('IMPORT_SAFE').run();
    await syncCheck('IMPORT_SAFE').run();

    expect([...roles(MEMBER)].sort()).toEqual([...rolesBefore].sort());
    // Nessun membro creato: sarebbe stato l'import, che qui non deve accadere.
    expect(await h.repos.members.findByDiscordId(MEMBER)).toBeNull();
    expect(h.store.history).toHaveLength(0);
  });
});
