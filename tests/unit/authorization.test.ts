/**
 * Permission matrix applicativa.
 *
 * Funzioni pure: nessun Discord, nessun database. Sono le regole che
 * proteggono la gerarchia della gang.
 */
import { describe, expect, it } from 'vitest';
import { MemberRank } from '../../src/generated/prisma/enums.js';
import {
  type ActorContext,
  canActOn,
  canAssignRank,
  can,
  DEFAULT_POLICY,
  type PermissionPolicy,
  type TargetContext,
} from '../../src/config/permissions.js';

function actor(overrides: Partial<ActorContext> = {}): ActorContext {
  return {
    discordId: '1',
    isBotOwner: false,
    isGuildOwner: false,
    isTtp: true,
    rank: MemberRank.BIG,
    highestRolePosition: 50,
    ...overrides,
  };
}

function target(overrides: Partial<TargetContext> = {}): TargetContext {
  return {
    discordId: '2',
    isTtp: true,
    rank: MemberRank.RESIDENT,
    highestRolePosition: 10,
    ...overrides,
  };
}

const permissive: PermissionPolicy = {
  ...DEFAULT_POLICY,
  bigCanManageBig: true,
  bigCanPromoteToLeadership: true,
  youngOgCanReviewApplications: true,
};

describe('owner del bot', () => {
  it('può fare tutto, anche su un OG', () => {
    const owner = actor({ isBotOwner: true, rank: undefined, isTtp: false });
    expect(can(owner, 'member.permadeath').allowed).toBe(true);
    expect(
      canActOn(owner, target({ rank: MemberRank.OG, highestRolePosition: 999 }), 'member.remove')
        .allowed,
    ).toBe(true);
  });
});

describe('OG', () => {
  const og = actor({ rank: MemberRank.OG, highestRolePosition: 90 });

  it('ha accesso completo alla Leadership', () => {
    for (const operation of [
      'member.add',
      'member.promote',
      'member.remove',
      'member.permadeath',
      'blacklist.manage',
      'panel.use',
    ] as const) {
      expect(can(og, operation).allowed).toBe(true);
    }
  });

  it('può assegnare qualsiasi rank', () => {
    expect(canAssignRank(og, MemberRank.OG).allowed).toBe(true);
    expect(canAssignRank(og, MemberRank.BIG).allowed).toBe(true);
  });
});

describe('Big', () => {
  const big = actor({ rank: MemberRank.BIG, highestRolePosition: 70 });

  it('NON può amministrare un OG', () => {
    const decision = canActOn(
      big,
      target({ rank: MemberRank.OG, highestRolePosition: 10 }),
      'member.remove',
    );
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toContain('OG');
  });

  it('NON può amministrare un altro Big con la policy di default', () => {
    const decision = canActOn(
      big,
      target({ rank: MemberRank.BIG, highestRolePosition: 10 }),
      'member.demote',
    );
    expect(decision.allowed).toBe(false);
  });

  it('può amministrare un altro Big se la policy lo abilita', () => {
    const decision = canActOn(
      big,
      target({ rank: MemberRank.BIG, highestRolePosition: 10 }),
      'member.demote',
      permissive,
    );
    expect(decision.allowed).toBe(true);
  });

  it('NON può eseguire il permadeath', () => {
    expect(can(big, 'member.permadeath').allowed).toBe(false);
  });

  it('NON può eseguire /setup né sync-check', () => {
    expect(can(big, 'setup.run').allowed).toBe(false);
    expect(can(big, 'system.check').allowed).toBe(false);
  });

  it('NON può creare Big o OG con la policy di default', () => {
    expect(canAssignRank(big, MemberRank.BIG).allowed).toBe(false);
    expect(canAssignRank(big, MemberRank.OG).allowed).toBe(false);
    expect(canAssignRank(big, MemberRank.YOUNG_OG).allowed).toBe(true);
  });

  it('può creare Big se la policy lo abilita', () => {
    expect(canAssignRank(big, MemberRank.BIG, permissive).allowed).toBe(true);
  });

  it('può gestire la blacklist di default, non se disabilitata', () => {
    expect(can(big, 'blacklist.manage').allowed).toBe(true);
    expect(
      can(big, 'blacklist.manage', { ...DEFAULT_POLICY, bigCanBlacklist: false }).allowed,
    ).toBe(false);
  });
});

describe('Young OG', () => {
  const youngOg = actor({ rank: MemberRank.YOUNG_OG, highestRolePosition: 40 });

  it('può leggere roster e schede', () => {
    expect(can(youngOg, 'roster.view').allowed).toBe(true);
    expect(can(youngOg, 'member.info').allowed).toBe(true);
  });

  it('NON può revisionare le candidature di default', () => {
    expect(can(youngOg, 'application.review').allowed).toBe(false);
  });

  it('può revisionare le candidature se la policy lo abilita', () => {
    expect(can(youngOg, 'application.review', permissive).allowed).toBe(true);
  });

  it('NON può promuovere né rimuovere', () => {
    expect(can(youngOg, 'member.promote').allowed).toBe(false);
    expect(can(youngOg, 'member.remove').allowed).toBe(false);
  });
});

describe('Gangster e Resident', () => {
  it('hanno accesso in sola lettura', () => {
    for (const rank of [MemberRank.GANGSTER, MemberRank.RESIDENT]) {
      const member = actor({ rank, highestRolePosition: 20 });
      expect(can(member, 'roster.view').allowed).toBe(true);
      expect(can(member, 'member.info').allowed).toBe(true);
      expect(can(member, 'member.promote').allowed).toBe(false);
      expect(can(member, 'blacklist.manage').allowed).toBe(false);
    }
  });
});

describe('non-membri', () => {
  it('non possono eseguire operazioni amministrative', () => {
    const outsider = actor({ rank: undefined, isTtp: false, highestRolePosition: 1 });
    expect(can(outsider, 'member.add').allowed).toBe(false);
    expect(can(outsider, 'community.manage').allowed).toBe(false);
  });
});

describe('regole trasversali', () => {
  it('nessuno può amministrare sé stesso', () => {
    const og = actor({ discordId: 'same', rank: MemberRank.OG, highestRolePosition: 90 });
    const self = target({ discordId: 'same', rank: MemberRank.OG, highestRolePosition: 90 });
    expect(canActOn(og, self, 'member.demote').allowed).toBe(false);
  });

  it('nessuno può amministrare un rank superiore al proprio', () => {
    const gangsterAsBig = actor({ rank: MemberRank.BIG, highestRolePosition: 70 });
    const decision = canActOn(
      gangsterAsBig,
      target({ rank: MemberRank.OG, highestRolePosition: 10 }),
      'member.status',
    );
    expect(decision.allowed).toBe(false);
  });

  it('la gerarchia Discord reale viene rispettata', () => {
    const og = actor({ rank: MemberRank.OG, highestRolePosition: 30 });
    // Il bersaglio ha un ruolo Discord più alto: Discord non lo permetterebbe.
    const decision = canActOn(
      og,
      target({ rank: MemberRank.RESIDENT, highestRolePosition: 99 }),
      'member.promote',
    );
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toContain('gerarchia Discord');
  });

  it('il guild owner è esente dal controllo di gerarchia Discord', () => {
    const guildOwner = actor({
      rank: MemberRank.OG,
      isGuildOwner: true,
      highestRolePosition: 5,
    });
    const decision = canActOn(
      guildOwner,
      target({ rank: MemberRank.RESIDENT, highestRolePosition: 99 }),
      'member.promote',
    );
    expect(decision.allowed).toBe(true);
  });
});
