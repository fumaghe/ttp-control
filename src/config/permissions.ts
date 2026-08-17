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
 * Il rank `BIG` della nuova gerarchia e' un rank NUOVO, non e' Leadership e
 * non e' toccato da nessuna di queste policy.
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
  readonly isTtp: boolean;
  readonly rank: MemberRank | undefined;
  /** Posizione del ruolo Discord piu' alto: serve per la gerarchia reale. */
  readonly highestRolePosition: number;
}

/** Su chi si sta agendo. */
export interface TargetContext {
  readonly discordId: string;
  readonly isTtp: boolean;
  readonly rank: MemberRank | undefined;
  readonly highestRolePosition: number;
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
 * `OG` e l'ex `BIG`, che oggi si chiama `BIG_HOMIE`. Il nuovo rank `BIG`, che
 * sta piu' in basso, NON e' Leadership: ha lo stesso nome del vecchio ma un
 * altro ruolo Discord e un altro significato.
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
  // L'owner del bot ha sempre accesso completo.
  if (actor.isBotOwner) return ALLOW;

  if (READ_ONLY_OPERATIONS.has(operation)) return ALLOW;

  switch (actor.rank) {
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
    //
    // Qui dentro c'e' anche il NUOVO `BIG`: sta piu' in alto di
    // ORIGINAL_TINY_LOC nella gerarchia, ma la gerarchia ordina i rank, non
    // distribuisce privilegi. Il vecchio `BIG` amministrativo e' diventato
    // `BIG_HOMIE`, e i rank introdotti con la nuova scala non ereditano
    // permessi solo perche' sono nuovi o perche' ne riusano il nome: chi
    // vuole dargliene deve aggiungerli qui esplicitamente.
    case MemberRank.BIG:
    case MemberRank.LOC:
    case MemberRank.TINY_LOC:
    case MemberRank.INFANTIL_LOC:
    case MemberRank.GANG_BANGER:
    case MemberRank.RESIDENT:
    case undefined:
      return deny('Non hai i permessi necessari per questa operazione.');

    default: {
      const exhaustive: never = actor.rank;
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

  if (MUTATING_MEMBER_OPERATIONS.has(operation)) {
    if (actor.discordId === target.discordId) {
      return deny('Non puoi eseguire questa operazione su te stesso.');
    }

    // Big Homie non amministra OG, mai.
    if (actor.rank === MemberRank.BIG_HOMIE && target.rank === MemberRank.OG) {
      return deny('Un Big Homie non puo’ amministrare un OG.');
    }

    // Big Homie non amministra un altro Big Homie, salvo policy esplicita.
    if (
      actor.rank === MemberRank.BIG_HOMIE &&
      target.rank === MemberRank.BIG_HOMIE &&
      !policy.bigCanManageBig
    ) {
      return deny('Un Big Homie non puo’ amministrare un altro Big Homie con la policy attuale.');
    }

    // Nessuno puo' amministrare un rank superiore al proprio.
    if (
      actor.rank !== undefined &&
      target.rank !== undefined &&
      compareRanks(target.rank, actor.rank) > 0
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
 * esplicitamente. Il nuovo rank `BIG` non e' Leadership, quindi resta
 * assegnabile da un Big Homie come ogni altro rank sotto di lui.
 */
export function canAssignRank(
  actor: ActorContext,
  targetRank: MemberRank,
  policy: PermissionPolicy = DEFAULT_POLICY,
): AuthorizationDecision {
  if (actor.isBotOwner || actor.rank === MemberRank.OG) return ALLOW;

  if (actor.rank === MemberRank.BIG_HOMIE) {
    if (isLeadershipRank(targetRank) && !policy.bigCanPromoteToLeadership) {
      return deny(
        'Un Big Homie non puo’ assegnare il rank Big Homie o OG con la policy attuale: serve un OG.',
      );
    }
    return ALLOW;
  }

  return deny('Non hai i permessi per assegnare rank.');
}
