/**
 * Stato Discord normalizzato e invarianti di importabilità.
 *
 * Funzioni PURE: nessun database, nessun Discord, nessun orologio. Sono le
 * regole che decidono cosa il bot può dedurre da solo dai ruoli e cosa no —
 * cioè il confine fra "il gestionale si aggiorna da sé" e "serve una persona".
 */
import { describe, expect, it } from 'vitest';
import { MemberRank, MemberStatus, SpecialRole } from '../../src/generated/prisma/enums.js';
import { buildRoleRegistry } from '../../src/config/roles.js';
import {
  type DatabaseRoleState,
  evaluateRoleState,
  isValidTtpState,
  planRoleImport,
  readDiscordRoleState,
  type RoleImportPlan,
} from '../../src/services/discordRoleState.js';
import type { GuildMemberSnapshot } from '../../src/services/roleGateway.js';
import { ROLE_IDS, testEnv } from '../support/harness.js';

const registry = buildRoleRegistry(testEnv());

function snapshot(roleIds: readonly string[]): GuildMemberSnapshot {
  return {
    discordId: '400000000000000001',
    username: 'tony',
    displayName: 'Tony Montana',
    roleIds: new Set(roleIds),
    highestRolePosition: 1,
    isGuildOwner: false,
  };
}

function db(overrides: Partial<DatabaseRoleState> = {}): DatabaseRoleState {
  return {
    member: null,
    verificationActive: false,
    blacklisted: false,
    specialRoles: [],
    ...overrides,
  };
}

function member(
  rank: MemberRank,
  status: MemberStatus,
  version = 0,
): NonNullable<DatabaseRoleState['member']> {
  return { id: 'mem_1', rank, status, version };
}

function plan(roleIds: readonly string[], database: DatabaseRoleState = db()): RoleImportPlan {
  return planRoleImport(readDiscordRoleState(snapshot(roleIds), registry), database);
}

/** Codici delle violazioni di un piano `warning`. */
function issueCodes(result: RoleImportPlan): string[] {
  return result.kind === 'warning' ? result.issues.map((issue) => issue.code) : [];
}

describe('lettura dello stato Discord', () => {
  it('riconosce i ruoli gestiti per ID, non per nome', () => {
    const state = readDiscordRoleState(
      snapshot([ROLE_IDS.verified, ROLE_IDS.ttp, ROLE_IDS.loc, ROLE_IDS.shooter, ROLE_IDS.friend]),
      registry,
    );

    expect(state.verified).toBe(true);
    expect(state.ttp).toBe(true);
    expect(state.rank).toBe(MemberRank.LOC);
    expect(state.specialRoles).toEqual([SpecialRole.SHOOTER]);
    expect(state.friend).toBe(true);
    expect(state.mafia).toBe(false);
  });

  it('ignora i ruoli che il bot non gestisce', () => {
    const state = readDiscordRoleState(snapshot(['299999999999999999']), registry);
    expect(state.ranks).toEqual([]);
    expect(state.verified).toBe(false);
  });

  it('con DUE rank lascia `rank` indefinito invece di scegliere il più alto', () => {
    // È l'invariante di sicurezza centrale: scegliere il maggiore renderebbe
    // l'escalation gratuita — basterebbe farsi assegnare un secondo ruolo.
    const state = readDiscordRoleState(
      snapshot([ROLE_IDS.verified, ROLE_IDS.ttp, ROLE_IDS.resident, ROLE_IDS.og]),
      registry,
    );

    expect(state.ranks).toEqual([MemberRank.RESIDENT, MemberRank.OG]);
    expect(state.rank).toBeUndefined();
  });

  it('con ZERO rank lascia `rank` indefinito', () => {
    const state = readDiscordRoleState(snapshot([ROLE_IDS.verified, ROLE_IDS.ttp]), registry);
    expect(state.rank).toBeUndefined();
  });

  it('ordina i rank dal più basso al più alto, non nell’ordine di Discord', () => {
    const state = readDiscordRoleState(
      snapshot([ROLE_IDS.og, ROLE_IDS.resident, ROLE_IDS.loc]),
      registry,
    );
    expect(state.ranks).toEqual([MemberRank.RESIDENT, MemberRank.LOC, MemberRank.OG]);
  });
});

describe('invariante del membro TTP valido', () => {
  const valid = [ROLE_IDS.verified, ROLE_IDS.ttp, ROLE_IDS.resident];

  it('richiede TTP, Verified ed esattamente un rank', () => {
    expect(isValidTtpState(readDiscordRoleState(snapshot(valid), registry), db())).toBe(true);
  });

  it.each([
    ['senza Verified', [ROLE_IDS.ttp, ROLE_IDS.resident]],
    ['senza TTP', [ROLE_IDS.verified, ROLE_IDS.resident]],
    ['senza rank', [ROLE_IDS.verified, ROLE_IDS.ttp]],
    ['con due rank', [ROLE_IDS.verified, ROLE_IDS.ttp, ROLE_IDS.resident, ROLE_IDS.og]],
    ['con Permadeath', [...valid, ROLE_IDS.permadeath]],
  ])('non è valido %s', (_name, roleIds) => {
    expect(isValidTtpState(readDiscordRoleState(snapshot(roleIds), registry), db())).toBe(false);
  });

  it('non è valido se l’utente è in blacklist a database', () => {
    // Il database è autorevole sulla blacklist: nessun ruolo Discord la aggira.
    expect(
      isValidTtpState(readDiscordRoleState(snapshot(valid), registry), db({ blacklisted: true })),
    ).toBe(false);
  });

  it('non è valido se il membro è PERMADEATH a database', () => {
    expect(
      isValidTtpState(
        readDiscordRoleState(snapshot(valid), registry),
        db({ member: member(MemberRank.RESIDENT, MemberStatus.PERMADEATH) }),
      ),
    ).toBe(false);
  });
});

describe('stati ambigui: si segnalano, non si interpretano', () => {
  it.each([
    ['TTP senza Verified', [ROLE_IDS.ttp, ROLE_IDS.resident], 'TTP_WITHOUT_VERIFIED'],
    ['TTP senza rank', [ROLE_IDS.verified, ROLE_IDS.ttp], 'TTP_WITHOUT_RANK'],
    [
      'TTP con due rank',
      [ROLE_IDS.verified, ROLE_IDS.ttp, ROLE_IDS.resident, ROLE_IDS.og],
      'MULTIPLE_RANKS',
    ],
    ['rank senza TTP', [ROLE_IDS.verified, ROLE_IDS.og], 'RANK_WITHOUT_TTP'],
    [
      'Inactive senza membership',
      [ROLE_IDS.verified, ROLE_IDS.inactive],
      'INACTIVE_WITHOUT_MEMBERSHIP',
    ],
    [
      'ruolo speciale senza membership',
      [ROLE_IDS.verified, ROLE_IDS.shooter],
      'SPECIAL_ROLE_WITHOUT_MEMBERSHIP',
    ],
  ])('%s produce un warning e nessuna azione', (_name, roleIds, code) => {
    const result = plan(roleIds);
    expect(result.kind).toBe('warning');
    expect(issueCodes(result)).toContain(code);
  });

  it('un warning non importa mai nulla, nemmeno la parte valida', () => {
    // Con due rank il Verified sarebbe di per sé importabile: non lo si importa
    // lo stesso. Uno stato ambiguo si tratta come un blocco, non come qualcosa
    // da cui recuperare i pezzi che tornano.
    const result = plan([ROLE_IDS.verified, ROLE_IDS.ttp, ROLE_IDS.resident, ROLE_IDS.og]);
    expect(result.kind).toBe('warning');
  });

  it('elenca TUTTE le violazioni, non solo la prima', () => {
    const issues = evaluateRoleState(
      readDiscordRoleState(snapshot([ROLE_IDS.ttp]), registry),
      db(),
    );
    expect(issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['TTP_WITHOUT_VERIFIED', 'TTP_WITHOUT_RANK']),
    );
  });

  it('ogni violazione dice cosa fare, senza farlo', () => {
    const issues = evaluateRoleState(
      readDiscordRoleState(snapshot([ROLE_IDS.ttp, ROLE_IDS.resident]), registry),
      db(),
    );
    expect(issues[0]?.suggestion).toBeTruthy();
  });
});

describe('sbarramenti autorevoli a database', () => {
  it('un utente in blacklist con Verified o TTP è bloccato, non segnalato e basta', () => {
    const result = plan([ROLE_IDS.verified], db({ blacklisted: true }));
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') expect(result.issue.code).toBe('BLACKLISTED_WITH_ACCESS');
  });

  it('Permadeath insieme a TTP è uno stato non interpretabile', () => {
    const result = plan([ROLE_IDS.verified, ROLE_IDS.ttp, ROLE_IDS.resident, ROLE_IDS.permadeath]);
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.issue.code).toBe('PERMADEATH_WITH_MEMBERSHIP_ROLES');
    }
  });

  it('un membro PERMADEATH non rientra perché gli riassegnano un ruolo', () => {
    const result = plan(
      [ROLE_IDS.verified, ROLE_IDS.ttp, ROLE_IDS.resident],
      db({ member: member(MemberRank.OG, MemberStatus.PERMADEATH), verificationActive: true }),
    );
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') expect(result.issue.code).toBe('PERMADEATH_MEMBER_REASSIGNED');
  });

  it('il solo ruolo Permadeath, senza TTP né rank, è uno stato legittimo', () => {
    // È esattamente come resta un membro dopo `/member permadeath`.
    const result = plan(
      [ROLE_IDS.verified, ROLE_IDS.permadeath],
      db({ member: member(MemberRank.LOC, MemberStatus.PERMADEATH), verificationActive: true }),
    );
    expect(result.kind).toBe('unchanged');
  });
});

describe('transizioni importabili', () => {
  it('Verified aggiunto a mano crea la verifica mancante', () => {
    const result = plan([ROLE_IDS.verified]);
    expect(result).toEqual({ kind: 'actions', actions: [{ kind: 'import-verification' }] });
  });

  it('Verified + TTP + un rank crea il membro', () => {
    const result = plan(
      [ROLE_IDS.verified, ROLE_IDS.ttp, ROLE_IDS.bigHomie],
      db({ verificationActive: true }),
    );
    expect(result).toEqual({
      kind: 'actions',
      actions: [{ kind: 'create-member', rank: MemberRank.BIG_HOMIE, status: MemberStatus.ACTIVE }],
    });
  });

  it('un membro LEFT viene riattivato, non duplicato', () => {
    const result = plan(
      [ROLE_IDS.verified, ROLE_IDS.ttp, ROLE_IDS.resident],
      db({ member: member(MemberRank.LOC, MemberStatus.LEFT), verificationActive: true }),
    );
    expect(result).toEqual({
      kind: 'actions',
      actions: [
        { kind: 'reactivate-member', rank: MemberRank.RESIDENT, status: MemberStatus.ACTIVE },
      ],
    });
  });

  it('un rank diverso da quello a database diventa un cambio di rank', () => {
    const result = plan(
      [ROLE_IDS.verified, ROLE_IDS.ttp, ROLE_IDS.og],
      db({ member: member(MemberRank.RESIDENT, MemberStatus.ACTIVE), verificationActive: true }),
    );
    expect(result).toEqual({
      kind: 'actions',
      actions: [{ kind: 'set-rank', from: MemberRank.RESIDENT, to: MemberRank.OG }],
    });
  });

  it('il ruolo Inactive diventa lo stato INACTIVE', () => {
    const result = plan(
      [ROLE_IDS.verified, ROLE_IDS.ttp, ROLE_IDS.resident, ROLE_IDS.inactive],
      db({ member: member(MemberRank.RESIDENT, MemberStatus.ACTIVE), verificationActive: true }),
    );
    expect(result).toEqual({
      kind: 'actions',
      actions: [{ kind: 'set-status', from: MemberStatus.ACTIVE, to: MemberStatus.INACTIVE }],
    });
  });

  it('i ruoli speciali si allineano in ENTRAMBE le direzioni', () => {
    const result = plan(
      [ROLE_IDS.verified, ROLE_IDS.ttp, ROLE_IDS.resident, ROLE_IDS.shooter, ROLE_IDS.honor1],
      db({
        member: member(MemberRank.RESIDENT, MemberStatus.ACTIVE),
        verificationActive: true,
        specialRoles: [SpecialRole.HONOR_1, SpecialRole.SUPPORTER],
      }),
    );

    expect(result.kind).toBe('actions');
    if (result.kind !== 'actions') return;
    expect(result.actions).toEqual([
      { kind: 'add-special-role', role: SpecialRole.SHOOTER },
      { kind: 'remove-special-role', role: SpecialRole.SUPPORTER },
    ]);
  });

  it('combina più transizioni in un solo piano', () => {
    const result = plan(
      [ROLE_IDS.verified, ROLE_IDS.ttp, ROLE_IDS.loc, ROLE_IDS.inactive, ROLE_IDS.mainShooter],
      db({ member: member(MemberRank.RESIDENT, MemberStatus.ACTIVE), verificationActive: true }),
    );

    expect(result.kind).toBe('actions');
    if (result.kind !== 'actions') return;
    expect(result.actions.map((action) => action.kind)).toEqual([
      'set-rank',
      'set-status',
      'add-special-role',
    ]);
  });
});

describe('nessuna transizione distruttiva viene dedotta', () => {
  it('togliere TTP a un membro attivo NON produce un’uscita dalla gang', () => {
    const result = plan(
      [ROLE_IDS.verified],
      db({ member: member(MemberRank.LOC, MemberStatus.ACTIVE), verificationActive: true }),
    );
    expect(result.kind).toBe('warning');
    expect(issueCodes(result)).toContain('TTP_REMOVED_FROM_MEMBER');
  });

  it('togliere Verified a un membro TTP NON revoca la verifica', () => {
    const result = plan(
      [ROLE_IDS.ttp, ROLE_IDS.loc],
      db({ member: member(MemberRank.LOC, MemberStatus.ACTIVE), verificationActive: true }),
    );
    expect(result.kind).toBe('warning');
    expect(issueCodes(result)).toEqual(
      expect.arrayContaining(['TTP_WITHOUT_VERIFIED', 'VERIFIED_REMOVED']),
    );
  });

  it('il ruolo Banned da solo non produce nessuna azione', () => {
    // Una blacklist ha bisogno di una motivazione e di un autore: un ruolo
    // Discord non porta con sé né l'una né l'altro.
    expect(plan([ROLE_IDS.banned]).kind).toBe('unchanged');
  });

  it('Friend e Mafia non generano divergenze', () => {
    // Sono già letti direttamente da Discord e non hanno una tabella dedicata.
    expect(plan([ROLE_IDS.friend, ROLE_IDS.mafia]).kind).toBe('unchanged');
  });
});

describe('idempotenza del piano', () => {
  it('uno stato già allineato non produce nessuna azione', () => {
    const result = plan(
      [ROLE_IDS.verified, ROLE_IDS.ttp, ROLE_IDS.resident, ROLE_IDS.shooter],
      db({
        member: member(MemberRank.RESIDENT, MemberStatus.ACTIVE),
        verificationActive: true,
        specialRoles: [SpecialRole.SHOOTER],
      }),
    );
    expect(result).toEqual({ kind: 'unchanged' });
  });

  it('un utente senza nessun ruolo gestito non produce nulla', () => {
    expect(plan([])).toEqual({ kind: 'unchanged' });
  });
});
