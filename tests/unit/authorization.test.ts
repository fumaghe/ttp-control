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
  isLeadershipRank,
  type PermissionPolicy,
  type TargetContext,
} from '../../src/config/permissions.js';

function actor(overrides: Partial<ActorContext> = {}): ActorContext {
  return {
    discordId: '1',
    isBotOwner: false,
    isGuildOwner: false,
    isTtp: true,
    rank: MemberRank.BIG_HOMIE,
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
    for (const rank of Object.values(MemberRank)) {
      expect(canAssignRank(og, rank).allowed).toBe(true);
    }
  });
});

/**
 * Ex `BIG` della gerarchia a cinque rank: eredita le sue policy, invariate.
 * Il rank che oggi si chiama `BIG` è un altro — vedi il describe in fondo.
 */
describe('Big Homie', () => {
  const bigHomie = actor({ rank: MemberRank.BIG_HOMIE, highestRolePosition: 70 });

  it('NON può amministrare un OG', () => {
    const decision = canActOn(
      bigHomie,
      target({ rank: MemberRank.OG, highestRolePosition: 10 }),
      'member.remove',
    );
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toContain('OG');
  });

  it('NON può amministrare un altro Big Homie con la policy di default', () => {
    const decision = canActOn(
      bigHomie,
      target({ rank: MemberRank.BIG_HOMIE, highestRolePosition: 10 }),
      'member.demote',
    );
    expect(decision.allowed).toBe(false);
  });

  it('può amministrare un altro Big Homie se la policy lo abilita', () => {
    const decision = canActOn(
      bigHomie,
      target({ rank: MemberRank.BIG_HOMIE, highestRolePosition: 10 }),
      'member.demote',
      permissive,
    );
    expect(decision.allowed).toBe(true);
  });

  it('può amministrare un membro del nuovo rank BIG, che gli sta sotto', () => {
    const decision = canActOn(
      bigHomie,
      target({ rank: MemberRank.BIG, highestRolePosition: 10 }),
      'member.demote',
    );
    expect(decision.allowed).toBe(true);
  });

  it('NON può eseguire il permadeath', () => {
    expect(can(bigHomie, 'member.permadeath').allowed).toBe(false);
  });

  it('NON può eseguire /setup né sync-check', () => {
    expect(can(bigHomie, 'setup.run').allowed).toBe(false);
    expect(can(bigHomie, 'system.check').allowed).toBe(false);
  });

  it('NON può creare Big Homie o OG con la policy di default', () => {
    expect(canAssignRank(bigHomie, MemberRank.BIG_HOMIE).allowed).toBe(false);
    expect(canAssignRank(bigHomie, MemberRank.OG).allowed).toBe(false);
  });

  it('può assegnare ogni rank NON Leadership, incluso il nuovo BIG', () => {
    for (const rank of [
      MemberRank.RESIDENT,
      MemberRank.GANG_BANGER,
      MemberRank.INFANTIL_LOC,
      MemberRank.TINY_LOC,
      MemberRank.LOC,
      MemberRank.ORIGINAL_TINY_LOC,
      MemberRank.BIG,
    ]) {
      expect(canAssignRank(bigHomie, rank).allowed).toBe(true);
    }
  });

  it('può creare Big Homie se la policy lo abilita', () => {
    expect(canAssignRank(bigHomie, MemberRank.BIG_HOMIE, permissive).allowed).toBe(true);
  });

  it('può gestire la blacklist di default, non se disabilitata', () => {
    expect(can(bigHomie, 'blacklist.manage').allowed).toBe(true);
    expect(
      can(bigHomie, 'blacklist.manage', { ...DEFAULT_POLICY, bigCanBlacklist: false }).allowed,
    ).toBe(false);
  });
});

/** Ex `YOUNG_OG`: eredita le sue policy, invariate. */
describe('Original Tiny Loc', () => {
  const originalTinyLoc = actor({
    rank: MemberRank.ORIGINAL_TINY_LOC,
    highestRolePosition: 40,
  });

  it('può leggere roster e schede', () => {
    expect(can(originalTinyLoc, 'roster.view').allowed).toBe(true);
    expect(can(originalTinyLoc, 'member.info').allowed).toBe(true);
  });

  it('può leggere le note della Leadership, come l’ex Young OG', () => {
    expect(can(originalTinyLoc, 'member.notes.view').allowed).toBe(true);
  });

  it('NON può revisionare le candidature di default', () => {
    expect(can(originalTinyLoc, 'application.review').allowed).toBe(false);
  });

  it('può revisionare le candidature se la policy lo abilita', () => {
    expect(can(originalTinyLoc, 'application.review', permissive).allowed).toBe(true);
  });

  it('NON può promuovere né rimuovere', () => {
    expect(can(originalTinyLoc, 'member.promote').allowed).toBe(false);
    expect(can(originalTinyLoc, 'member.remove').allowed).toBe(false);
  });
});

/**
 * Il punto più delicato della migrazione a nove rank.
 *
 * `BIG` esisteva anche prima ed era il rank amministrativo della gang. Oggi
 * quel rank si chiama `BIG_HOMIE`, e `BIG` è un rank NUOVO, più in basso, con
 * un altro ruolo Discord. Se ereditasse le policy per omonimia, la gang si
 * ritroverebbe un'intera fascia di membri promossi ad amministratori senza
 * che nessuno l'abbia deciso.
 */
describe('il nuovo BIG non eredita i privilegi del vecchio BIG', () => {
  const newBig = actor({ rank: MemberRank.BIG, highestRolePosition: 60 });

  it('NON è un rank Leadership', () => {
    expect(isLeadershipRank(MemberRank.BIG)).toBe(false);
    expect(isLeadershipRank(MemberRank.BIG_HOMIE)).toBe(true);
    expect(isLeadershipRank(MemberRank.OG)).toBe(true);
  });

  it('NON può eseguire nessuna delle operazioni che spettavano al vecchio Big', () => {
    for (const operation of [
      'member.add',
      'member.promote',
      'member.demote',
      'member.rank',
      'member.remove',
      'member.status',
      'member.specialRoles',
      'member.notes.view',
      'application.review',
      'community.manage',
      'blacklist.manage',
      'panel.use',
    ] as const) {
      expect(can(newBig, operation).allowed).toBe(false);
    }
  });

  it('non guadagna nulla nemmeno con la policy più permissiva', () => {
    expect(can(newBig, 'blacklist.manage', permissive).allowed).toBe(false);
    expect(can(newBig, 'panel.use', permissive).allowed).toBe(false);
    expect(can(newBig, 'application.review', permissive).allowed).toBe(false);
  });

  it('NON può assegnare rank', () => {
    expect(canAssignRank(newBig, MemberRank.RESIDENT).allowed).toBe(false);
    expect(canAssignRank(newBig, MemberRank.BIG).allowed).toBe(false);
  });

  it('resta comunque in sola lettura, come ogni altro membro', () => {
    expect(can(newBig, 'roster.view').allowed).toBe(true);
    expect(can(newBig, 'member.info').allowed).toBe(true);
  });
});

describe('rank senza privilegi amministrativi', () => {
  /** Tutta la gerarchia tranne i due rank Leadership e Original Tiny Loc. */
  const plainRanks = [
    MemberRank.RESIDENT,
    MemberRank.GANG_BANGER,
    MemberRank.INFANTIL_LOC,
    MemberRank.TINY_LOC,
    MemberRank.LOC,
    MemberRank.BIG,
  ] as const;

  it('hanno accesso in sola lettura', () => {
    for (const rank of plainRanks) {
      const member = actor({ rank, highestRolePosition: 20 });
      expect(can(member, 'roster.view').allowed).toBe(true);
      expect(can(member, 'member.info').allowed).toBe(true);
      expect(can(member, 'member.promote').allowed).toBe(false);
      expect(can(member, 'blacklist.manage').allowed).toBe(false);
      expect(can(member, 'member.notes.view').allowed).toBe(false);
    }
  });

  it('i rank nuovi non hanno ricevuto privilegi solo perché sono nuovi', () => {
    for (const rank of [
      MemberRank.GANG_BANGER,
      MemberRank.INFANTIL_LOC,
      MemberRank.LOC,
      MemberRank.BIG,
    ]) {
      const member = actor({ rank, highestRolePosition: 20 });
      expect(can(member, 'member.add').allowed).toBe(false);
      expect(can(member, 'setup.run').allowed).toBe(false);
      expect(can(member, 'system.check').allowed).toBe(false);
    }
  });
});

describe('solo Leadership amministra', () => {
  it('esattamente due rank possono eseguire member.remove', () => {
    const allowed = Object.values(MemberRank).filter(
      (rank) => can(actor({ rank, highestRolePosition: 20 }), 'member.remove').allowed,
    );
    expect(allowed).toEqual([MemberRank.BIG_HOMIE, MemberRank.OG]);
  });

  it('solo OG può eseguire permadeath, setup e sync-check', () => {
    for (const operation of ['member.permadeath', 'setup.run', 'system.check'] as const) {
      const allowed = Object.values(MemberRank).filter(
        (rank) => can(actor({ rank, highestRolePosition: 20 }), operation).allowed,
      );
      expect(allowed).toEqual([MemberRank.OG]);
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
