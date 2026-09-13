/**
 * Permission matrix APPLICATIVA.
 *
 * Non ci si affida alle Discord permission: l'autorizzazione e' logica di
 * dominio e viene rivalutata a OGNI interaction, anche sui click dei bottoni
 * di un pannello generato in precedenza da un utente autorizzato.
 *
 * Questo modulo e' volutamente puro (nessun accesso a Discord o al database):
 * riceve dei contesti gia' risolti e restituisce una decisione. Cosi' e'
 * interamente testabile.
 */
import { MemberRank } from '../generated/prisma/enums.js';
import { compareRanks } from './constants.js';

/** Operazioni protette dalla matrice. */
export const OPERATIONS = [
  'roster.view',
  'member.info',
  'member.notes.view',
  'application.review',
  'member.add',
  'member.promote',
  'member.demote',
  'member.rank',
  'member.specialRoles',
  'member.status',
  'member.remove',
  'member.permadeath',
  'community.manage',
  'blacklist.manage',
  'panel.use',
  'setup.run',
  'system.check',
] as const;

export type Operation = (typeof OPERATIONS)[number];

/**
 * Policy configurabili per-guild (persistite in `GuildConfig`).
 * I default sono la lettura piu' restrittiva della matrice del master prompt.
 *
 * NOMI LEGACY, SIGNIFICATO AGGIORNATO. Questi campi sono colonne di
 * `GuildConfig` e conservano il nome che avevano con la gerarchia a cinque
 * rank, per non richiedere una migration puramente cosmetica:
 *
 *   `big*`     -> si applica a **BIG_HOMIE** (l'ex `BIG`)
 *   `youngOg*` -> si applica a **ORIGINAL_TINY_LOC** (l'ex `YOUNG_OG`)
 *
 */
export interface PermissionPolicy {
  /** Big Homie puo' amministrare un altro Big Homie. Default: no. */
  readonly bigCanManageBig: boolean;
  /** Big Homie puo' portare qualcuno a BIG_HOMIE o OG. Default: no. */
  readonly bigCanPromoteToLeadership: boolean;
  /** Big Homie puo' gestire la blacklist. Default: si. */
  readonly bigCanBlacklist: boolean;
  /** Big Homie puo' aprire il control panel. Default: si. */
  readonly bigCanUseControlPanel: boolean;
  /** Original Tiny Loc puo' revisionare le candidature TTP. Default: no. */
  readonly youngOgCanReviewApplications: boolean;
}

export const DEFAULT_POLICY: PermissionPolicy = {
  bigCanManageBig: false,
  bigCanPromoteToLeadership: false,
  bigCanBlacklist: true,
  bigCanUseControlPanel: true,
  youngOgCanReviewApplications: false,
};

/** Chi sta eseguendo l'operazione, con lo stato gia' risolto da Discord + DB. */
export interface ActorContext {
  readonly discordId: string;
  /** OWNER_ID dal `.env`: accesso amministrativo completo, sempre. */
  readonly isBotOwner: boolean;
  /** Proprietario della guild Discord. */
  readonly isGuildOwner: boolean;
  /** Possiede `RUOLO TTP`. Senza, nessun rank vale ai fini dei permessi. */
  readonly isTtp: boolean;
  /**
   * TUTTI i rank posseduti su Discord, non "il rank".
   *
   * La molteplicita' e' un'informazione di sicurezza e non va appiattita prima
   * di arrivare qui: chi decide che cosa farne e' `authorizedRank`.
   */
  readonly ranks: readonly MemberRank[];
  /** Posizione del ruolo Discord piu' alto: serve per la gerarchia reale. */
  readonly highestRolePosition: number;
}

/** Su chi si sta agendo. */
export interface TargetContext {
  readonly discordId: string;
  readonly isTtp: boolean;
  /** Tutti i rank posseduti dal bersaglio. Vedi `protectedRank`. */
  readonly ranks: readonly MemberRank[];
  readonly highestRolePosition: number;
}

/**
 * Il rank che vale AI FINI DEI PERMESSI per chi esegue l'operazione.
 *
 * Due condizioni, entrambe necessarie:
 *
 *  1. `isTtp`. Un rank e' una posizione DENTRO la gang: senza il ruolo TTP non
 *     c'e' nessuna gang in cui avere una posizione. Chi si vede assegnare il
 *     ruolo OG senza il ruolo TTP ha un ruolo colorato, non un grado.
 *  2. `ranks.length === 1`. Con piu' rank lo stato non e' interpretabile in
 *     modo univoco, e la risposta NON e' scegliere il piu' alto: sarebbe
 *     un'escalation a costo zero, perche' basterebbe farsi assegnare un
 *     secondo ruolo qualsiasi accanto a quello alto per ottenerne i privilegi.
 *     Si nega e si segnala.
 *
 * `OWNER_ID` non passa di qui: il suo override viene applicato prima, in `can`.
 *
 * @returns il rank utilizzabile, oppure `undefined` — che significa "nessun
 *          privilegio amministrativo", non "rank sconosciuto".
 */
export function authorizedRank(actor: ActorContext): MemberRank | undefined {
  if (!actor.isTtp) return undefined;
  if (actor.ranks.length !== 1) return undefined;
  return actor.ranks[0];
}

/**
 * Il rank da cui il BERSAGLIO e' protetto.
 *
 * Asimmetrico rispetto a `authorizedRank`, di proposito. Per l'attore
 * l'ambiguita' toglie privilegi; per il bersaglio ne toglierebbe protezione — un
 * membro con due rank diventerebbe amministrabile da chiunque gli stia sotto.
 * Quindi qui si prende il piu' alto fra quelli posseduti: fra le due letture
 * possibili si sceglie sempre quella che nega, mai quella che concede.
 */
export function protectedRank(target: TargetContext): MemberRank | undefined {
  let highest: MemberRank | undefined;
  for (const rank of target.ranks) {
    if (highest === undefined || compareRanks(rank, highest) > 0) highest = rank;
  }
  return highest;
}

/**
 * Lo stato dei ruoli dell'attore e' ambiguo: piu' rank insieme, oppure un rank
 * senza il ruolo TTP. In entrambi i casi nessun privilegio viene dedotto, e la
 * combinazione merita una segnalazione di consistenza.
 */
export function hasAmbiguousRankState(actor: ActorContext): boolean {
  return actor.ranks.length > 1 || (actor.ranks.length > 0 && !actor.isTtp);
}

export type AuthorizationDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

const ALLOW: AuthorizationDecision = { allowed: true };

function deny(reason: string): AuthorizationDecision {
  return { allowed: false, reason };
}

/** Operazioni consentite a chiunque possa vedere il gestionale. */
const READ_ONLY_OPERATIONS: ReadonlySet<Operation> = new Set<Operation>([
  'roster.view',
  'member.info',
]);

/** Operazioni riservate a OG (e owner). */
const OG_ONLY_OPERATIONS: ReadonlySet<Operation> = new Set<Operation>([
  'member.permadeath',
  'setup.run',
  'system.check',
]);

/**
 * Operazioni che un Big Homie puo' eseguire, oltre a quelle read-only,
 * indipendentemente dalla policy.
 */
const BIG_HOMIE_OPERATIONS: ReadonlySet<Operation> = new Set<Operation>([
  'member.notes.view',
  'application.review',
  'member.add',
  'member.promote',
  'member.demote',
  'member.rank',
  'member.specialRoles',
  'member.status',
  'member.remove',
  'community.manage',
]);

/**
 * Il rank e' considerato Leadership.
 *
 * Sono ESATTAMENTE i due rank che lo erano con la gerarchia a cinque livelli:
 * `OG` e l'ex `BIG`, che oggi si chiama `BIG_HOMIE`.
 */
export function isLeadershipRank(rank: MemberRank | undefined): boolean {
  return rank === MemberRank.OG || rank === MemberRank.BIG_HOMIE;
}

/**
 * Puo' l'attore eseguire l'operazione, a prescindere dal bersaglio?
 *
 * Il controllo sul bersaglio e' separato: vedi `canActOn`.
 */
export function can(
  actor: ActorContext,
  operation: Operation,
  policy: PermissionPolicy = DEFAULT_POLICY,
): AuthorizationDecision {
  // L'owner del bot ha sempre accesso completo: e' l'override che consente di
  // intervenire anche quando la configurazione dei ruoli e' rotta.
  if (actor.isBotOwner) return ALLOW;

  if (READ_ONLY_OPERATIONS.has(operation)) return ALLOW;

  // Il rank NON si legge mai direttamente dall'attore: passa sempre da qui,
  // che e' il punto in cui "TTP + esattamente un rank" viene fatto valere.
  const rank = authorizedRank(actor);

  // Distinguere il diniego per ambiguita' da quello per rank insufficiente non
  // e' cosmesi: senza, chi ha due rank per sbaglio vede "non hai i permessi" e
  // non ha modo di capire che il problema e' il secondo ruolo.
  if (rank === undefined && hasAmbiguousRankState(actor)) {
    return deny(
      actor.isTtp
        ? 'Hai piu di un rank contemporaneamente: nessun privilegio amministrativo viene dedotto. Lascia un solo ruolo rank e riprova.'
        : 'Hai un ruolo rank ma non il ruolo TTP: senza membership il rank non concede nessun permesso.',
    );
  }

  switch (rank) {
    case MemberRank.OG:
      return ALLOW;

    // Ex `BIG` della gerarchia a cinque rank: eredita esattamente le sue
    // capacita', ne' una in piu'.
    case MemberRank.BIG_HOMIE: {
      if (OG_ONLY_OPERATIONS.has(operation)) {
        return deny(`L'operazione \`${operation}\` e' riservata agli OG.`);
      }
      if (operation === 'blacklist.manage') {
        return policy.bigCanBlacklist
          ? ALLOW
          : deny('La policy della gang non consente ai Big Homie di gestire la blacklist.');
      }
      if (operation === 'panel.use') {
        return policy.bigCanUseControlPanel
          ? ALLOW
          : deny('La policy della gang non consente ai Big Homie di usare il control panel.');
      }
      return BIG_HOMIE_OPERATIONS.has(operation)
        ? ALLOW
        : deny(`L'operazione \`${operation}\` non e' consentita ai Big Homie.`);
    }

    // Ex `YOUNG_OG`: eredita esattamente le sue capacita'.
    case MemberRank.ORIGINAL_TINY_LOC: {
      if (operation === 'member.notes.view') return ALLOW;
      if (operation === 'application.review') {
        return policy.youngOgCanReviewApplications
          ? ALLOW
          : deny(
              'La policy della gang non consente agli Original Tiny Loc di revisionare le candidature.',
            );
      }
      return deny(`L'operazione \`${operation}\` richiede almeno il rank Big Homie.`);
    }

    // Tutti gli altri rank non amministrano nulla.
    case MemberRank.LOC:
    case MemberRank.TINY_LOC:
    case MemberRank.INFANTIL_LOC:
    case MemberRank.GANG_BANGER:
    case MemberRank.RESIDENT:
    case undefined:
      return deny('Non hai i permessi necessari per questa operazione.');

    default: {
      const exhaustive: never = rank;
      return deny(`Rank sconosciuto: ${String(exhaustive)}`);
    }
  }
}

/** Operazioni che modificano un membro e richiedono i controlli sul bersaglio. */
const MUTATING_MEMBER_OPERATIONS: ReadonlySet<Operation> = new Set<Operation>([
  'member.add',
  'member.promote',
  'member.demote',
  'member.rank',
  'member.specialRoles',
  'member.status',
  'member.remove',
  'member.permadeath',
  'application.review',
  'community.manage',
  'blacklist.manage',
]);

/**
 * Puo' l'attore eseguire l'operazione SU QUESTO bersaglio?
 *
 * Somma tre controlli indipendenti:
 *   1. la matrice applicativa (`can`);
 *   2. le regole di rank (Big non tocca OG, Big non tocca Big, no self-target);
 *   3. la gerarchia Discord reale.
 */
export function canActOn(
  actor: ActorContext,
  target: TargetContext,
  operation: Operation,
  policy: PermissionPolicy = DEFAULT_POLICY,
): AuthorizationDecision {
  const base = can(actor, operation, policy);
  if (!base.allowed) return base;

  if (actor.isBotOwner) return ALLOW;

  // Stesse due letture asimmetriche usate ovunque: il rank dell'attore vale
  // solo se non ambiguo, quello del bersaglio e' il piu' alto che possiede.
  const actorRank = authorizedRank(actor);
  const targetRank = protectedRank(target);

  if (MUTATING_MEMBER_OPERATIONS.has(operation)) {
    if (actor.discordId === target.discordId) {
      return deny('Non puoi eseguire questa operazione su te stesso.');
    }

    // Big Homie non amministra OG, mai.
    if (actorRank === MemberRank.BIG_HOMIE && targetRank === MemberRank.OG) {
      return deny('Un Big Homie non puo’ amministrare un OG.');
    }

    // Big Homie non amministra un altro Big Homie, salvo policy esplicita.
    if (
      actorRank === MemberRank.BIG_HOMIE &&
      targetRank === MemberRank.BIG_HOMIE &&
      !policy.bigCanManageBig
    ) {
      return deny('Un Big Homie non puo’ amministrare un altro Big Homie con la policy attuale.');
    }

    // Nessuno puo' amministrare un rank superiore al proprio.
    if (
      actorRank !== undefined &&
      targetRank !== undefined &&
      compareRanks(targetRank, actorRank) > 0
    ) {
      return deny('Non puoi amministrare un membro di rank superiore al tuo.');
    }
  }

  // Gerarchia Discord reale: il guild owner ne e' esente.
  if (!actor.isGuildOwner && target.highestRolePosition >= actor.highestRolePosition) {
    return deny(
      'La gerarchia Discord non te lo consente: il bersaglio ha un ruolo pari o superiore al tuo.',
    );
  }

  return ALLOW;
}

/**
 * Puo' l'attore portare un membro esattamente a `targetRank`?
 *
 * Vale per promote, demote e cambio rank diretto: un Big Homie non deve poter
 * creare altri Big Homie o OG a meno che la policy non lo consenta
 * esplicitamente.
 */
export function canAssignRank(
  actor: ActorContext,
  targetRank: MemberRank,
  policy: PermissionPolicy = DEFAULT_POLICY,
): AuthorizationDecision {
  if (actor.isBotOwner) return ALLOW;

  const rank = authorizedRank(actor);
  if (rank === MemberRank.OG) return ALLOW;

  if (rank === MemberRank.BIG_HOMIE) {
    if (isLeadershipRank(targetRank) && !policy.bigCanPromoteToLeadership) {
      return deny(
        'Un Big Homie non puo’ assegnare il rank Big Homie o OG con la policy attuale: serve un OG.',
      );
    }
    return ALLOW;
  }

  return deny('Non hai i permessi per assegnare rank.');
}
