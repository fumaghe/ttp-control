/**
 * Membership TTP: ingresso, gerarchia, stato, uscita, permadeath.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MemberHistoryEvent,
  MemberRank,
  MemberStatus,
  SpecialRole,
} from '../../src/generated/prisma/enums.js';
import { ERROR_CODE } from '../../src/errors/AppError.js';
import {
  addFakeMember,
  createHarness,
  ROLE_IDS,
  verifyUser,
  type Harness,
} from '../support/harness.js';

const USER = '900000000000000001';
const OG = '900000000000000010';

/** Tutti e nove i ruoli della gerarchia: un membro TTP ne ha esattamente uno. */
const ALL_RANK_ROLE_IDS = [
  ROLE_IDS.resident,
  ROLE_IDS.gangBanger,
  ROLE_IDS.infantilLoc,
  ROLE_IDS.tinyLoc,
  ROLE_IDS.loc,
  ROLE_IDS.originalTinyLoc,
  ROLE_IDS.big,
  ROLE_IDS.bigHomie,
  ROLE_IDS.og,
];

let h: Harness;

/** Utente verificato e già dentro la gang, pronto per i test di gerarchia. */
async function joinedMember(rank: MemberRank = MemberRank.RESIDENT): Promise<void> {
  addFakeMember(h.guild, USER, { position: 1 });
  await verifyUser(h, USER);
  await h.members.addToGang({
    discordId: USER,
    actorDiscordId: OG,
    rank,
    source: 'manual',
  });
}

beforeEach(() => {
  h = createHarness();
  addFakeMember(h.guild, OG, { roles: [ROLE_IDS.ttp, ROLE_IDS.og], position: 90 });
});

describe('ingresso nella gang', () => {
  it('assegna Verified, TTP e il rank', async () => {
    await joinedMember();

    const roles = h.guild.members.get(USER)?.roles;
    expect(roles?.has(ROLE_IDS.verified)).toBe(true);
    expect(roles?.has(ROLE_IDS.ttp)).toBe(true);
    expect(roles?.has(ROLE_IDS.resident)).toBe(true);
  });

  it('usa RESIDENT come rank di default', async () => {
    addFakeMember(h.guild, USER);
    await verifyUser(h, USER);
    const outcome = await h.members.addToGang({
      discordId: USER,
      actorDiscordId: OG,
      source: 'manual',
    });

    expect(outcome.member.rank).toBe(MemberRank.RESIDENT);
  });

  it('rifiuta un utente non verificato: `TTP ⇒ Verified`', async () => {
    addFakeMember(h.guild, USER);

    await expect(
      h.members.addToGang({ discordId: USER, actorDiscordId: OG, source: 'manual' }),
    ).rejects.toMatchObject({ code: ERROR_CODE.NOT_VERIFIED });
  });

  it('rifiuta un utente in blacklist', async () => {
    addFakeMember(h.guild, USER);
    await verifyUser(h, USER);
    await h.blacklist.add({ discordId: USER, reason: 'Motivo', actorDiscordId: OG });

    await expect(
      h.members.addToGang({ discordId: USER, actorDiscordId: OG, source: 'manual' }),
    ).rejects.toMatchObject({ code: ERROR_CODE.BLACKLISTED });
  });

  it('è idempotente: un secondo ingresso non duplica il membro', async () => {
    await joinedMember();
    const second = await h.members.addToGang({
      discordId: USER,
      actorDiscordId: OG,
      source: 'manual',
    });

    expect(second.alreadyMember).toBe(true);
    expect(h.store.members.size).toBe(1);
  });

  it('registra JOINED_TTP nello storico', async () => {
    await joinedMember();
    expect(h.store.history.some((entry) => entry.event === MemberHistoryEvent.JOINED_TTP)).toBe(
      true,
    );
  });

  it('segnala i ruoli community senza rimuoverli d’ufficio', async () => {
    addFakeMember(h.guild, USER, { roles: [ROLE_IDS.friend] });
    await verifyUser(h, USER);
    const outcome = await h.members.addToGang({
      discordId: USER,
      actorDiscordId: OG,
      source: 'manual',
    });

    expect(outcome.warnings.some((w) => w.includes('Friend'))).toBe(true);
    // La policy di default non li rimuove: resta una decisione umana.
    expect(h.guild.members.get(USER)?.roles.has(ROLE_IDS.friend)).toBe(true);
  });
});

describe('promote', () => {
  it('Resident → Gang Banger', async () => {
    await joinedMember(MemberRank.RESIDENT);
    const outcome = await h.members.promote({
      discordId: USER,
      actorDiscordId: OG,
      reason: 'Merito',
    });

    expect(outcome.toRank).toBe(MemberRank.GANG_BANGER);
    expect(h.guild.members.get(USER)?.roles.has(ROLE_IDS.gangBanger)).toBe(true);
  });

  it('avanza di UN solo gradino lungo tutta la gerarchia', async () => {
    // Ogni coppia è un gradino della scala a nove rank: un promote non deve
    // mai saltarne uno, nemmeno fra i rank aggiunti dopo la V1.
    const steps = [
      [MemberRank.RESIDENT, MemberRank.GANG_BANGER],
      [MemberRank.GANG_BANGER, MemberRank.INFANTIL_LOC],
      [MemberRank.INFANTIL_LOC, MemberRank.TINY_LOC],
      [MemberRank.TINY_LOC, MemberRank.LOC],
      [MemberRank.LOC, MemberRank.ORIGINAL_TINY_LOC],
      [MemberRank.ORIGINAL_TINY_LOC, MemberRank.BIG],
      [MemberRank.BIG, MemberRank.BIG_HOMIE],
      [MemberRank.BIG_HOMIE, MemberRank.OG],
    ] as const;

    for (const [from, to] of steps) {
      h = createHarness();
      await joinedMember(from);
      const outcome = await h.members.promote({
        discordId: USER,
        actorDiscordId: OG,
        reason: 'Merito',
      });
      expect(outcome.fromRank).toBe(from);
      expect(outcome.toRank).toBe(to);
    }
  });

  it('lascia esattamente un rank dopo la promozione', async () => {
    await joinedMember(MemberRank.RESIDENT);
    await h.members.promote({ discordId: USER, actorDiscordId: OG, reason: 'Merito' });

    const roles = h.guild.members.get(USER)?.roles;
    const rankRoles = ALL_RANK_ROLE_IDS.filter((id) => roles?.has(id));

    expect(rankRoles).toHaveLength(1);
    expect(rankRoles[0]).toBe(ROLE_IDS.gangBanger);
  });

  it('rifiuta la promozione oltre OG', async () => {
    await joinedMember(MemberRank.OG);
    await expect(
      h.members.promote({ discordId: USER, actorDiscordId: OG, reason: 'Merito' }),
    ).rejects.toMatchObject({ code: ERROR_CODE.RANK_AT_MAXIMUM });
  });

  it('rifiuta la promozione di chi non è TTP', async () => {
    addFakeMember(h.guild, USER);
    await verifyUser(h, USER);

    await expect(
      h.members.promote({ discordId: USER, actorDiscordId: OG, reason: 'Merito' }),
    ).rejects.toMatchObject({ code: ERROR_CODE.NOT_TTP });
  });
});

describe('demote', () => {
  it('retrocede di UN solo gradino lungo tutta la gerarchia', async () => {
    const steps = [
      [MemberRank.OG, MemberRank.BIG_HOMIE],
      [MemberRank.BIG_HOMIE, MemberRank.BIG],
      [MemberRank.BIG, MemberRank.ORIGINAL_TINY_LOC],
      [MemberRank.ORIGINAL_TINY_LOC, MemberRank.LOC],
      [MemberRank.LOC, MemberRank.TINY_LOC],
      [MemberRank.TINY_LOC, MemberRank.INFANTIL_LOC],
      [MemberRank.INFANTIL_LOC, MemberRank.GANG_BANGER],
      [MemberRank.GANG_BANGER, MemberRank.RESIDENT],
    ] as const;

    for (const [from, to] of steps) {
      h = createHarness();
      await joinedMember(from);
      const outcome = await h.members.demote({
        discordId: USER,
        actorDiscordId: OG,
        reason: 'Inattività',
      });
      expect(outcome.fromRank).toBe(from);
      expect(outcome.toRank).toBe(to);
    }
  });

  it('un Resident non viene espulso dalla gang: si indica /member remove', async () => {
    await joinedMember(MemberRank.RESIDENT);

    await expect(
      h.members.demote({ discordId: USER, actorDiscordId: OG, reason: 'Motivo' }),
    ).rejects.toMatchObject({ code: ERROR_CODE.RANK_AT_MINIMUM });

    // Resta membro a tutti gli effetti.
    expect(h.guild.members.get(USER)?.roles.has(ROLE_IDS.ttp)).toBe(true);
    expect((await h.members.find(USER))?.status).toBe(MemberStatus.ACTIVE);
  });
});

describe('inactive / active', () => {
  it('inactive conserva membership, rank e badge', async () => {
    await joinedMember(MemberRank.TINY_LOC);
    await h.members.addSpecialRole({
      discordId: USER,
      actorDiscordId: OG,
      role: SpecialRole.SHOOTER,
    });

    await h.members.setInactive({ discordId: USER, actorDiscordId: OG });

    const roles = h.guild.members.get(USER)?.roles;
    expect(roles?.has(ROLE_IDS.inactive)).toBe(true);
    expect(roles?.has(ROLE_IDS.ttp)).toBe(true);
    expect(roles?.has(ROLE_IDS.tinyLoc)).toBe(true);
    expect(roles?.has(ROLE_IDS.verified)).toBe(true);
    expect(roles?.has(ROLE_IDS.shooter)).toBe(true);
    expect((await h.members.find(USER))?.status).toBe(MemberStatus.INACTIVE);
  });

  it('inactive è idempotente', async () => {
    await joinedMember();
    await h.members.setInactive({ discordId: USER, actorDiscordId: OG });
    const second = await h.members.setInactive({ discordId: USER, actorDiscordId: OG });

    expect(second.changed).toBe(false);
  });

  it('active rimuove il ruolo Inactive e conserva il resto', async () => {
    await joinedMember(MemberRank.TINY_LOC);
    await h.members.setInactive({ discordId: USER, actorDiscordId: OG });
    await h.members.setActive({ discordId: USER, actorDiscordId: OG });

    const roles = h.guild.members.get(USER)?.roles;
    expect(roles?.has(ROLE_IDS.inactive)).toBe(false);
    expect(roles?.has(ROLE_IDS.ttp)).toBe(true);
    expect(roles?.has(ROLE_IDS.tinyLoc)).toBe(true);
    expect((await h.members.find(USER))?.status).toBe(MemberStatus.ACTIVE);
  });
});

describe('rimozione dalla gang', () => {
  it('conserva Verified', async () => {
    await joinedMember(MemberRank.TINY_LOC);
    await h.members.removeFromGang({
      discordId: USER,
      actorDiscordId: OG,
      reason: 'Uscita volontaria',
    });

    const roles = h.guild.members.get(USER)?.roles;
    expect(roles?.has(ROLE_IDS.verified)).toBe(true);
    expect(roles?.has(ROLE_IDS.ttp)).toBe(false);
    expect(roles?.has(ROLE_IDS.tinyLoc)).toBe(false);
  });

  it('non cancella il record né lo storico', async () => {
    await joinedMember();
    await h.members.removeFromGang({ discordId: USER, actorDiscordId: OG, reason: 'Motivo' });

    const member = await h.members.find(USER);
    expect(member).not.toBeNull();
    expect(member?.status).toBe(MemberStatus.LEFT);
    expect(member?.leftTtpAt).not.toBeNull();
    expect(h.store.history.some((e) => e.event === MemberHistoryEvent.LEFT_TTP)).toBe(true);
    expect(h.store.history.some((e) => e.event === MemberHistoryEvent.JOINED_TTP)).toBe(true);
  });

  it('rimuove i ruoli speciali secondo la policy di default', async () => {
    await joinedMember();
    await h.members.addSpecialRole({
      discordId: USER,
      actorDiscordId: OG,
      role: SpecialRole.SHOOTER,
    });

    const outcome = await h.members.removeFromGang({
      discordId: USER,
      actorDiscordId: OG,
      reason: 'Motivo',
    });

    expect(outcome.removedSpecialRoles).toContain(SpecialRole.SHOOTER);
    expect(h.guild.members.get(USER)?.roles.has(ROLE_IDS.shooter)).toBe(false);
  });

  it('un ex membro può rientrare riusando lo stesso record', async () => {
    await joinedMember();
    await h.members.removeFromGang({ discordId: USER, actorDiscordId: OG, reason: 'Motivo' });

    await h.members.addToGang({ discordId: USER, actorDiscordId: OG, source: 'manual' });

    expect(h.store.members.size).toBe(1);
    expect((await h.members.find(USER))?.status).toBe(MemberStatus.ACTIVE);
  });
});

describe('permadeath', () => {
  it('assegna Permadeath e rimuove TTP e rank', async () => {
    await joinedMember(MemberRank.BIG_HOMIE);
    await h.members.permadeath({
      discordId: USER,
      actorDiscordId: OG,
      reason: 'Morte definitiva',
    });

    const roles = h.guild.members.get(USER)?.roles;
    expect(roles?.has(ROLE_IDS.permadeath)).toBe(true);
    expect(roles?.has(ROLE_IDS.ttp)).toBe(false);
    expect(roles?.has(ROLE_IDS.bigHomie)).toBe(false);
  });

  it('conserva il record e tutto lo storico', async () => {
    await joinedMember(MemberRank.TINY_LOC);
    await h.members.promote({ discordId: USER, actorDiscordId: OG, reason: 'Merito' });
    const historyBefore = h.store.history.length;

    await h.members.permadeath({ discordId: USER, actorDiscordId: OG, reason: 'Morte' });

    const member = await h.members.find(USER);
    expect(member).not.toBeNull();
    expect(member?.status).toBe(MemberStatus.PERMADEATH);
    // Lo storico cresce, non viene mai troncato.
    expect(h.store.history.length).toBeGreaterThan(historyBefore);
    expect(h.store.history.some((e) => e.event === MemberHistoryEvent.PROMOTED)).toBe(true);
  });
});

describe('ruoli speciali', () => {
  it('assegnare due volte lo stesso ruolo è idempotente', async () => {
    await joinedMember();
    const first = await h.members.addSpecialRole({
      discordId: USER,
      actorDiscordId: OG,
      role: SpecialRole.HONOR_1,
    });
    const second = await h.members.addSpecialRole({
      discordId: USER,
      actorDiscordId: OG,
      role: SpecialRole.HONOR_1,
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it('non tocca membership né rank', async () => {
    await joinedMember(MemberRank.TINY_LOC);
    await h.members.addSpecialRole({
      discordId: USER,
      actorDiscordId: OG,
      role: SpecialRole.MAIN_SHOOTER,
    });

    const roles = h.guild.members.get(USER)?.roles;
    expect(roles?.has(ROLE_IDS.mainShooter)).toBe(true);
    expect(roles?.has(ROLE_IDS.ttp)).toBe(true);
    expect(roles?.has(ROLE_IDS.tinyLoc)).toBe(true);
  });
});
