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
  authorizedRank,
  canActOn,
  canAssignRank,
  can,
  DEFAULT_POLICY,
  hasAmbiguousRankState,
  type PermissionPolicy,
  protectedRank,
  type TargetContext,
} from '../../src/config/permissions.js';

/**
 * Scorciatoia dei test: `rank` descrive il caso normale "esattamente un rank".
 *
 * I contesti reali portano `ranks`, una LISTA, perché la molteplicità è
 * un'informazione di sicurezza. Qui si traduce la scorciatoia nella lista, così
 * i casi che vogliono davvero due rank (o zero) li passano espliciti.
 */
interface RankShorthand {
  rank?: MemberRank | undefined;
}

function ranksFrom(
  overrides: { rank?: MemberRank | undefined; ranks?: readonly MemberRank[] },
  fallback: MemberRank,
): readonly MemberRank[] {
  if (overrides.ranks !== undefined) return overrides.ranks;
  if ('rank' in overrides) return overrides.rank === undefined ? [] : [overrides.rank];
  return [fallback];
}

function actor(overrides: Partial<ActorContext> & RankShorthand = {}): ActorContext {
  const { rank: _rank, ...rest } = overrides;
  return {
    discordId: '1',
    isBotOwner: false,
    isGuildOwner: false,
    isTtp: true,
    highestRolePosition: 50,
    ...rest,
    ranks: ranksFrom(overrides, MemberRank.BIG_HOMIE),
  };
}

function target(overrides: Partial<TargetContext> & RankShorthand = {}): TargetContext {
  const { rank: _rank, ...rest } = overrides;
  return {
    discordId: '2',
    isTtp: true,
    highestRolePosition: 10,
    ...rest,
    ranks: ranksFrom(overrides, MemberRank.RESIDENT),
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

/** Ex `BIG` della gerarchia a cinque rank: eredita le sue policy, invariate. */
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

  it('può amministrare un Original Tiny Loc, che gli sta sotto', () => {
    const decision = canActOn(
      bigHomie,
      target({ rank: MemberRank.ORIGINAL_TINY_LOC, highestRolePosition: 10 }),
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

  it('può assegnare ogni rank NON Leadership', () => {
    for (const rank of [
      MemberRank.RESIDENT,
      MemberRank.GANG_BANGER,
      MemberRank.INFANTIL_LOC,
      MemberRank.TINY_LOC,
      MemberRank.LOC,
      MemberRank.ORIGINAL_TINY_LOC,
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

describe('rank senza privilegi amministrativi', () => {
  /** Tutta la gerarchia tranne i due rank Leadership e Original Tiny Loc. */
  const plainRanks = [
    MemberRank.RESIDENT,
    MemberRank.GANG_BANGER,
    MemberRank.INFANTIL_LOC,
    MemberRank.TINY_LOC,
    MemberRank.LOC,
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
    for (const rank of [MemberRank.GANG_BANGER, MemberRank.INFANTIL_LOC, MemberRank.LOC]) {
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
    const lowerRank = actor({ rank: MemberRank.LOC, highestRolePosition: 70 });
    const decision = canActOn(
      lowerRank,
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

// =============================================================================
// Il rank vale solo con TTP e solo se non ambiguo
// =============================================================================

describe('un rank senza TTP non concede permessi', () => {
  // Un rank è una posizione DENTRO la gang. Senza il ruolo TTP non c'è nessuna
  // gang in cui avere una posizione: chi si fa assegnare `OG` e basta ha un
  // ruolo colorato, non un grado.

  it('OG senza TTP non ha i permessi da OG', () => {
    const og = actor({ isTtp: false, rank: MemberRank.OG });

    expect(can(og, 'member.permadeath').allowed).toBe(false);
    expect(can(og, 'setup.run').allowed).toBe(false);
    expect(can(og, 'system.check').allowed).toBe(false);
    expect(can(og, 'member.remove').allowed).toBe(false);
    expect(can(og, 'blacklist.manage').allowed).toBe(false);
  });

  it('Big Homie senza TTP non ha i permessi di Leadership', () => {
    const bigHomie = actor({ isTtp: false, rank: MemberRank.BIG_HOMIE });

    expect(can(bigHomie, 'member.add').allowed).toBe(false);
    expect(can(bigHomie, 'member.promote').allowed).toBe(false);
    expect(can(bigHomie, 'panel.use').allowed).toBe(false);
    expect(can(bigHomie, 'member.notes.view').allowed).toBe(false);
  });

  it('non può nemmeno assegnare rank', () => {
    expect(
      canAssignRank(actor({ isTtp: false, rank: MemberRank.OG }), MemberRank.RESIDENT).allowed,
    ).toBe(false);
  });

  it('non può agire su un bersaglio', () => {
    expect(
      canActOn(actor({ isTtp: false, rank: MemberRank.OG }), target(), 'member.remove').allowed,
    ).toBe(false);
  });

  it('conserva comunque la sola lettura, come ogni altro utente', () => {
    const og = actor({ isTtp: false, rank: MemberRank.OG });
    expect(can(og, 'roster.view').allowed).toBe(true);
    expect(can(og, 'member.info').allowed).toBe(true);
  });

  it('spiega che manca TTP, invece di un generico "non hai i permessi"', () => {
    const decision = can(actor({ isTtp: false, rank: MemberRank.OG }), 'member.remove');
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toContain('TTP');
  });
});

describe('più rank contemporaneamente non concedono nulla', () => {
  // La risposta all'ambiguità NON è scegliere il rank più alto: sarebbe
  // un'escalation gratuita, perché basterebbe farsi assegnare un secondo ruolo
  // qualunque accanto a quello alto per ottenerne i privilegi.

  const ambiguous = actor({ ranks: [MemberRank.RESIDENT, MemberRank.OG] });

  it('non concede i privilegi del rank più alto', () => {
    expect(can(ambiguous, 'member.permadeath').allowed).toBe(false);
    expect(can(ambiguous, 'setup.run').allowed).toBe(false);
    expect(can(ambiguous, 'member.add').allowed).toBe(false);
    expect(can(ambiguous, 'blacklist.manage').allowed).toBe(false);
  });

  it('non concede nemmeno quelli del rank più basso', () => {
    expect(can(ambiguous, 'member.notes.view').allowed).toBe(false);
  });

  it('non permette di assegnare rank', () => {
    expect(canAssignRank(ambiguous, MemberRank.RESIDENT).allowed).toBe(false);
  });

  it('è riconoscibile come stato da segnalare', () => {
    expect(hasAmbiguousRankState(ambiguous)).toBe(true);
    expect(hasAmbiguousRankState(actor({ isTtp: false, rank: MemberRank.OG }))).toBe(true);
    expect(hasAmbiguousRankState(actor({ rank: MemberRank.OG }))).toBe(false);
    expect(hasAmbiguousRankState(actor({ isTtp: false, rank: undefined }))).toBe(false);
  });

  it('spiega che il problema sono i due rank', () => {
    const decision = can(ambiguous, 'member.remove');
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toContain('rank');
  });
});

describe('TTP con esattamente un rank', () => {
  it('un OG con TTP ha i permessi da OG', () => {
    const og = actor({ isTtp: true, rank: MemberRank.OG });
    expect(can(og, 'member.permadeath').allowed).toBe(true);
    expect(can(og, 'setup.run').allowed).toBe(true);
    expect(canAssignRank(og, MemberRank.BIG_HOMIE).allowed).toBe(true);
  });

  it('`authorizedRank` restituisce quel rank e nessun altro', () => {
    expect(authorizedRank(actor({ isTtp: true, rank: MemberRank.OG }))).toBe(MemberRank.OG);
    expect(authorizedRank(actor({ isTtp: false, rank: MemberRank.OG }))).toBeUndefined();
    expect(authorizedRank(actor({ ranks: [MemberRank.OG, MemberRank.LOC] }))).toBeUndefined();
    expect(authorizedRank(actor({ ranks: [] }))).toBeUndefined();
  });
});

describe('l’owner del bot mantiene l’override completo', () => {
  it('senza TTP e senza nessun rank', () => {
    const owner = actor({ isBotOwner: true, isTtp: false, ranks: [] });

    expect(can(owner, 'member.permadeath').allowed).toBe(true);
    expect(can(owner, 'setup.run').allowed).toBe(true);
    expect(canAssignRank(owner, MemberRank.OG).allowed).toBe(true);
  });

  it('anche con due rank contemporaneamente', () => {
    // L'override esiste proprio per poter intervenire quando la
    // configurazione dei ruoli è rotta: se l'ambiguità lo bloccasse, non
    // servirebbe a niente nel solo caso in cui serve.
    const owner = actor({ isBotOwner: true, ranks: [MemberRank.RESIDENT, MemberRank.OG] });
    expect(can(owner, 'setup.run').allowed).toBe(true);
    expect(canActOn(owner, target({ rank: MemberRank.OG }), 'member.remove').allowed).toBe(true);
  });
});

describe('protezione del bersaglio: l’asimmetria è voluta', () => {
  it('un bersaglio con due rank è protetto dal più alto', () => {
    // Per l'attore l'ambiguità toglie privilegi; per il bersaglio non deve
    // togliere protezione, altrimenti farsi assegnare un rank basso in più
    // renderebbe un OG amministrabile da chiunque.
    const ambiguousTarget = target({
      ranks: [MemberRank.RESIDENT, MemberRank.OG],
      highestRolePosition: 10,
    });

    expect(protectedRank(ambiguousTarget)).toBe(MemberRank.OG);
    expect(
      canActOn(actor({ rank: MemberRank.BIG_HOMIE }), ambiguousTarget, 'member.remove').allowed,
    ).toBe(false);
  });

  it('un bersaglio senza rank non è protetto dalla regola di gerarchia', () => {
    expect(protectedRank(target({ ranks: [] }))).toBeUndefined();
  });
});
