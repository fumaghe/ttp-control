/**
 * Stato Discord normalizzato di un membro, e regole che dicono se è
 * importabile a database.
 *
 * MODULO PURO: nessun accesso a Discord, nessuna query, nessun effetto. Prende
 * uno snapshot già letto e una proiezione dello stato a database, e restituisce
 * una decisione. È la SINGOLA definizione delle invarianti di membership:
 * `DiscordRoleImportService` la usa per decidere cosa scrivere, `/system
 * sync-check` la usa per decidere cosa mostrare. Nessuno dei due riscrive le
 * regole per conto proprio.
 *
 * PRINCIPIO DI AUTORITÀ
 *  - Discord è autorevole su: Verified, membership TTP, rank, Inactive,
 *    badge e specializzazioni, Friend e Mafia.
 *  - Il database resta autorevole su: blacklist, permadeath, uscita definitiva
 *    dalla gang, candidature, dati IC/OOC, note, storico e audit.
 *
 * L'asimmetria è deliberata: da Discord si importano solo transizioni
 * COSTRUTTIVE e non ambigue. Tutto ciò che toglie qualcosa a qualcuno —
 * rimuovere TTP, azzerare i rank, permadeath, blacklist — resta un atto
 * amministrativo esplicito, perché un click sbagliato nella UI di Discord non
 * deve poter cancellare una membership.
 */
import { type MemberRank, MemberStatus, type SpecialRole } from '../generated/prisma/enums.js';
import { RANK_LABEL, rankIndex } from '../config/constants.js';
import type { RoleRegistry } from '../config/roles.js';
import type { GuildMemberSnapshot } from './roleGateway.js';

/**
 * Lo stato dei ruoli gestiti, letto da uno snapshot Discord.
 *
 * `ranks` è volutamente una lista: la molteplicità è un'informazione, non un
 * caso limite da appiattire. `rank` è valorizzato SOLO quando i rank sono
 * esattamente uno — mai "il più alto fra quelli presenti", che è il
 * comportamento che permetterebbe a chi si assegna due ruoli di ottenere i
 * privilegi del maggiore.
 */
export interface DiscordManagedRoleState {
  readonly verified: boolean;
  readonly ttp: boolean;
  /** Tutti i rank posseduti, dal più basso al più alto. */
  readonly ranks: readonly MemberRank[];
  /** Il rank, solo se non ambiguo (`ranks.length === 1`). */
  readonly rank?: MemberRank | undefined;
  readonly inactive: boolean;
  readonly permadeath: boolean;
  readonly specialRoles: readonly SpecialRole[];
  readonly friend: boolean;
  readonly mafia: boolean;
}

/** Proiezione dello stato a database necessaria a decidere. */
export interface DatabaseRoleState {
  /** Il record `Member`, se esiste (anche LEFT o PERMADEATH). */
  readonly member: {
    readonly id: string;
    readonly rank: MemberRank;
    readonly status: MemberStatus;
    readonly version: number;
  } | null;
  /** Esiste una verifica non revocata. */
  readonly verificationActive: boolean;
  /** Esiste una entry di blacklist attiva. */
  readonly blacklisted: boolean;
  /** Ruoli speciali attivi a database. */
  readonly specialRoles: readonly SpecialRole[];
}

/** Categorie di stato non importabile. */
export type RoleStateIssueCode =
  | 'TTP_WITHOUT_VERIFIED'
  | 'TTP_WITHOUT_RANK'
  | 'MULTIPLE_RANKS'
  | 'RANK_WITHOUT_TTP'
  | 'INACTIVE_WITHOUT_MEMBERSHIP'
  | 'SPECIAL_ROLE_WITHOUT_MEMBERSHIP'
  | 'BLACKLISTED_WITH_ACCESS'
  | 'PERMADEATH_WITH_MEMBERSHIP_ROLES'
  | 'PERMADEATH_MEMBER_REASSIGNED'
  | 'TTP_REMOVED_FROM_MEMBER'
  | 'VERIFIED_REMOVED';

export interface RoleStateIssue {
  readonly code: RoleStateIssueCode;
  /** Testo leggibile, già pronto per un warning o per `/system sync-check`. */
  readonly detail: string;
  /** Cosa deve fare un operatore. Nessuna di queste azioni è automatica. */
  readonly suggestion: string;
}

/**
 * Le modifiche a database che un import può produrre.
 *
 * Nessuna di queste tocca Discord: quando il piano viene calcolato, Discord è
 * GIÀ nello stato desiderato — è la sorgente da cui il piano nasce. Riscrivere
 * i ruoli sarebbe, nel migliore dei casi, una chiamata inutile; nel peggiore,
 * un ping-pong fra cron e comandi.
 */
export type RoleImportAction =
  | { readonly kind: 'import-verification' }
  | { readonly kind: 'create-member'; readonly rank: MemberRank; readonly status: MemberStatus }
  | { readonly kind: 'reactivate-member'; readonly rank: MemberRank; readonly status: MemberStatus }
  | { readonly kind: 'set-rank'; readonly from: MemberRank; readonly to: MemberRank }
  | { readonly kind: 'set-status'; readonly from: MemberStatus; readonly to: MemberStatus }
  | { readonly kind: 'add-special-role'; readonly role: SpecialRole }
  | { readonly kind: 'remove-special-role'; readonly role: SpecialRole };

/**
 * Esito del CALCOLO, separato dall'applicazione.
 *
 * La separazione è il punto: decidere cosa fare è una funzione pura e si
 * verifica senza database, senza Discord e senza orologio. Applicare è un
 * passo distinto, che può fallire per motivi che non riguardano la decisione.
 */
export type RoleImportPlan =
  /** Database e Discord già allineati: niente da scrivere. */
  | { readonly kind: 'unchanged' }
  /** Transizioni sicure da applicare, nell'ordine dato. */
  | { readonly kind: 'actions'; readonly actions: readonly RoleImportAction[] }
  /** Stato ambiguo o operazione distruttiva: si segnala, non si importa. */
  | { readonly kind: 'warning'; readonly issues: readonly RoleStateIssue[] }
  /** Un fatto autorevole a database vieta l'import (blacklist, permadeath). */
  | { readonly kind: 'blocked'; readonly issue: RoleStateIssue };

/** Legge i ruoli gestiti da uno snapshot Discord. */
export function readDiscordRoleState(
  snapshot: GuildMemberSnapshot,
  registry: RoleRegistry,
): DiscordManagedRoleState {
  const has = (roleId: string): boolean => snapshot.roleIds.has(roleId);

  const ranks: MemberRank[] = [];
  for (const roleId of registry.allRankIds) {
    if (!has(roleId)) continue;
    const rank = registry.rankFromRoleId(roleId);
    if (rank) ranks.push(rank);
  }
  // `allRankIds` segue RANK_ORDER, ma ordinare esplicitamente rende il
  // risultato indipendente da come il registry è costruito.
  ranks.sort((a, b) => rankIndex(a) - rankIndex(b));

  const specialRoles: SpecialRole[] = [];
  for (const roleId of registry.allSpecialIds) {
    if (!has(roleId)) continue;
    const role = registry.specialFromRoleId(roleId);
    if (role) specialRoles.push(role);
  }

  return {
    verified: has(registry.verified),
    ttp: has(registry.ttp),
    ranks,
    // Esattamente uno, altrimenti `undefined`: l'ambiguità non si risolve
    // scegliendo, si segnala.
    rank: ranks.length === 1 ? ranks[0] : undefined,
    inactive: has(registry.inactive),
    permadeath: has(registry.permadeath),
    specialRoles,
    friend: has(registry.friend),
    mafia: has(registry.mafia),
  };
}

/** Il rank più alto fra quelli posseduti, o `undefined` se non ce ne sono. */
export function highestRank(ranks: readonly MemberRank[]): MemberRank | undefined {
  return [...ranks].sort((a, b) => rankIndex(a) - rankIndex(b)).at(-1);
}

/** Lo stato a database dice che il membro fa ancora parte della gang. */
export function isInGangStatus(status: MemberStatus): boolean {
  return status === MemberStatus.ACTIVE || status === MemberStatus.INACTIVE;
}

/**
 * Lo stato Discord descrive un membro TTP valido?
 *
 * È l'invariante centrale, e si legge come una congiunzione perché è esattamente
 * così che va applicata: basta che uno solo dei termini cada perché lo stato
 * smetta di essere interpretabile in modo univoco.
 */
export function isValidTtpState(
  discord: DiscordManagedRoleState,
  database: DatabaseRoleState,
): boolean {
  return (
    discord.ttp &&
    discord.verified &&
    discord.ranks.length === 1 &&
    !discord.permadeath &&
    !database.blacklisted &&
    database.member?.status !== MemberStatus.PERMADEATH
  );
}

function issue(code: RoleStateIssueCode, detail: string, suggestion: string): RoleStateIssue {
  return { code, detail, suggestion };
}

function labelList(ranks: readonly MemberRank[]): string {
  return ranks.map((rank) => RANK_LABEL[rank]).join(' + ');
}

/**
 * Tutte le violazioni delle invarianti, per uno stato Discord dato.
 *
 * Restituisce una LISTA e non un booleano perché ogni voce va mostrata: dire
 * "stato invalido" senza dire quale ruolo manca costringe l'operatore a
 * ricostruire da sé cosa è successo.
 */
export function evaluateRoleState(
  discord: DiscordManagedRoleState,
  database: DatabaseRoleState,
): readonly RoleStateIssue[] {
  const issues: RoleStateIssue[] = [];
  const inGang = database.member !== null && isInGangStatus(database.member.status);
  const validTtp = isValidTtpState(discord, database);

  // --- Invarianti strutturali dello stato Discord ------------------------
  if (discord.ttp && !discord.verified) {
    issues.push(
      issue(
        'TTP_WITHOUT_VERIFIED',
        'Ha il ruolo TTP ma non Verified: viola l’invariante `TTP ⇒ Verified`.',
        'Assegna Verified con `/community verified`, oppure togli TTP.',
      ),
    );
  }
  if (discord.ttp && discord.ranks.length === 0) {
    issues.push(
      issue(
        'TTP_WITHOUT_RANK',
        'Ha il ruolo TTP ma nessun rank della gerarchia.',
        'Assegna un rank su Discord, oppure usa `/member rank`.',
      ),
    );
  }
  if (discord.ranks.length > 1) {
    issues.push(
      issue(
        'MULTIPLE_RANKS',
        `Ha ${discord.ranks.length} rank contemporaneamente: ${labelList(discord.ranks)}. Nessuno dei due viene scelto automaticamente.`,
        'Lascia un solo ruolo rank su Discord, oppure usa `/member rank`.',
      ),
    );
  }
  if (!discord.ttp && discord.ranks.length > 0) {
    issues.push(
      issue(
        'RANK_WITHOUT_TTP',
        `Ha un rank (${labelList(discord.ranks)}) senza il ruolo TTP: non è una membership.`,
        'Aggiungi TTP e Verified, oppure rimuovi il rank.',
      ),
    );
  }

  // --- Ruoli che presuppongono una membership valida ---------------------
  if (discord.inactive && !validTtp && !inGang) {
    issues.push(
      issue(
        'INACTIVE_WITHOUT_MEMBERSHIP',
        'Ha il ruolo Inactive senza una membership TTP valida: non c’è nessuno stato da mettere in pausa.',
        'Rimuovi Inactive, oppure regolarizza la membership.',
      ),
    );
  }
  if (discord.specialRoles.length > 0 && !validTtp && !inGang) {
    issues.push(
      issue(
        'SPECIAL_ROLE_WITHOUT_MEMBERSHIP',
        `Ha ruoli speciali (${discord.specialRoles.join(', ')}) senza essere un membro TTP.`,
        'Rimuovi i ruoli speciali, oppure regolarizza la membership.',
      ),
    );
  }

  // --- Operazioni distruttive: mai dedotte, sempre comandate -------------
  if (inGang && !discord.ttp) {
    issues.push(
      issue(
        'TTP_REMOVED_FROM_MEMBER',
        'Risulta membro a database ma il ruolo TTP è stato rimosso a mano: l’uscita dalla gang NON viene dedotta.',
        'Usa `/member remove` se ha davvero lasciato la gang, altrimenti riassegna TTP.',
      ),
    );
  }
  if (database.verificationActive && !discord.verified) {
    issues.push(
      issue(
        'VERIFIED_REMOVED',
        inGang || discord.ttp
          ? 'Ha una verifica attiva a database ma il ruolo Verified è stato rimosso a mano da un membro TTP: la verifica NON è stata revocata.'
          : 'Ha una verifica attiva a database ma non il ruolo Verified.',
        'Riassegna Verified con `/community verified`, oppure revoca con `/community revoke`.',
      ),
    );
  }

  return issues;
}

/**
 * Calcola il piano di importazione. Funzione pura.
 *
 * Ordine delle decisioni:
 *   1. i fatti autorevoli a database che VIETANO l'import (blacklist,
 *      permadeath) — hanno la precedenza su qualsiasi ruolo Discord;
 *   2. le invarianti: uno stato ambiguo non si importa e non si corregge;
 *   3. le sole transizioni sicure che restano.
 */
export function planRoleImport(
  discord: DiscordManagedRoleState,
  database: DatabaseRoleState,
): RoleImportPlan {
  // --- 1. Sbarramenti autorevoli a database ------------------------------
  if (database.blacklisted && (discord.ttp || discord.verified)) {
    return {
      kind: 'blocked',
      issue: issue(
        'BLACKLISTED_WITH_ACCESS',
        'È in blacklist ma conserva Verified e/o TTP: nessun import, la blacklist a database è autorevole.',
        'Revoca l’accesso con `/community revoke`, oppure rimuovilo dalla blacklist con `/blacklist remove`.',
      ),
    };
  }
  if (discord.permadeath && (discord.ttp || discord.ranks.length > 0)) {
    return {
      kind: 'blocked',
      issue: issue(
        'PERMADEATH_WITH_MEMBERSHIP_ROLES',
        'Ha il ruolo Permadeath insieme a TTP e/o a un rank: lo stato non è interpretabile.',
        'Risolvi a mano su Discord: il permadeath si registra con `/member permadeath`.',
      ),
    };
  }
  if (
    database.member?.status === MemberStatus.PERMADEATH &&
    (discord.ttp || discord.ranks.length > 0)
  ) {
    return {
      kind: 'blocked',
      issue: issue(
        'PERMADEATH_MEMBER_REASSIGNED',
        'È marcato PERMADEATH a database ma ha ricevuto di nuovo TTP o un rank: un permadeath non si annulla assegnando un ruolo.',
        'Se il personaggio è davvero rientrato, registralo con `/member add`.',
      ),
    };
  }

  // --- 2. Invarianti ------------------------------------------------------
  const issues = evaluateRoleState(discord, database);
  if (issues.length > 0) return { kind: 'warning', issues };

  // --- 3. Transizioni sicure ----------------------------------------------
  const actions: RoleImportAction[] = [];

  // Verified aggiunto a mano: si crea la verifica amministrativa mancante.
  // La RIMOZIONE non ha un'azione corrispondente: è coperta da `VERIFIED_REMOVED`.
  if (discord.verified && !database.verificationActive) {
    actions.push({ kind: 'import-verification' });
  }

  if (isValidTtpState(discord, database)) {
    // `rank` è definito per costruzione: `isValidTtpState` richiede
    // `ranks.length === 1`, che è la stessa condizione che lo valorizza.
    const rank = discord.rank;
    if (rank !== undefined) {
      const status = discord.inactive ? MemberStatus.INACTIVE : MemberStatus.ACTIVE;
      const member = database.member;

      if (member === null) {
        actions.push({ kind: 'create-member', rank, status });
      } else if (member.status === MemberStatus.LEFT) {
        actions.push({ kind: 'reactivate-member', rank, status });
      } else {
        // PERMADEATH è già uscito come `blocked`: qui resta solo ACTIVE/INACTIVE.
        if (member.rank !== rank) {
          actions.push({ kind: 'set-rank', from: member.rank, to: rank });
        }
        if (member.status !== status) {
          actions.push({ kind: 'set-status', from: member.status, to: status });
        }
      }

      // Badge e specializzazioni: il database deve riflettere ESATTAMENTE i
      // ruoli presenti su Discord. Vale in entrambe le direzioni, ma solo per
      // un membro valido — su un non-membro sarebbe già uscito come issue.
      const onDiscord = new Set(discord.specialRoles);
      const onDatabase = new Set(database.specialRoles);
      for (const role of discord.specialRoles) {
        if (!onDatabase.has(role)) actions.push({ kind: 'add-special-role', role });
      }
      for (const role of database.specialRoles) {
        if (!onDiscord.has(role)) actions.push({ kind: 'remove-special-role', role });
      }
    }
  }

  if (actions.length === 0) return { kind: 'unchanged' };
  return { kind: 'actions', actions };
}

/**
 * Descrizione leggibile di una transizione.
 *
 * Serve a DUE chiamanti con bisogni opposti: il cron in `REPORT_ONLY`, che deve
 * dire "ecco cosa importerei ma non importo", e `/system sync-check`, che deve
 * dire "ecco cosa il prossimo cron sistemerà da solo". Averla qui, accanto alle
 * regole, è ciò che impedisce ai due di raccontare storie diverse.
 */
export function describeRoleImportAction(action: RoleImportAction): string {
  switch (action.kind) {
    case 'import-verification':
      return 'Ha il ruolo Verified ma nessuna verifica attiva a database.';
    case 'create-member':
      return `Ha TTP + ${RANK_LABEL[action.rank]} su Discord ma non esiste nessun record Member.`;
    case 'reactivate-member':
      return `Risulta uscito dalla gang a database ma ha di nuovo TTP + ${RANK_LABEL[action.rank]} su Discord.`;
    case 'set-rank':
      return `Rank Discord (${RANK_LABEL[action.to]}) diverso dal database (${RANK_LABEL[action.from]}).`;
    case 'set-status':
      return action.to === MemberStatus.INACTIVE
        ? 'Ha il ruolo Inactive su Discord ma a database è ACTIVE.'
        : 'È INACTIVE a database ma il ruolo Inactive non è più presente su Discord.';
    case 'add-special-role':
      return `Ha il ruolo speciale ${action.role} su Discord ma non a database.`;
    case 'remove-special-role':
      return `Ha il ruolo speciale ${action.role} a database ma non più su Discord.`;
    default: {
      const exhaustive: never = action;
      throw new Error(`Azione di import sconosciuta: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Il comando con cui un operatore applicherebbe a mano la stessa transizione.
 *
 * In `IMPORT_SAFE` non serve a nessuno — il cron ci arriva da solo — ma in
 * `REPORT_ONLY` è l'unica via, e `/system sync-check` deve poterla indicare.
 */
export function suggestionForAction(action: RoleImportAction): string {
  switch (action.kind) {
    case 'import-verification':
      return 'Registra la verifica con `/community verified`.';
    case 'create-member':
      return 'Regolarizza l’ingresso con `/member add`.';
    case 'reactivate-member':
      return 'Regolarizza il rientro con `/member add`.';
    case 'set-rank':
      return 'Allinea il rank con `/member rank`.';
    case 'set-status':
      return 'Allinea lo stato con `/member inactive` oppure `/member active`.';
    case 'add-special-role':
    case 'remove-special-role':
      return 'Allinea i ruoli speciali con `/member roles`.';
    default: {
      const exhaustive: never = action;
      throw new Error(`Azione di import sconosciuta: ${JSON.stringify(exhaustive)}`);
    }
  }
}
