/**
 * Costanti di dominio stabili, non configurabili via env.
 *
 * Regola: gli ID Discord (ruoli, canali, guild) NON stanno qui.
 * Vivono in `.env` e vengono esposti tipizzati da `src/config/env.ts`.
 */
import { MemberRank } from '../generated/prisma/enums.js';

export const BOT_NAME = 'TTP Control';
export const BOT_VERSION = '1.0.0';

/** Nome della gang, usato negli embed. */
export const GANG_NAME = 'TTP — Impero';

/**
 * Gerarchia TTP in ordine crescente.
 *
 * `promote` avanza di una posizione, `demote` retrocede di una.
 * L'ordine di questo array e' l'unica fonte di verita' sulla gerarchia:
 * non duplicarlo altrove.
 */
export const RANK_ORDER = [
  MemberRank.RESIDENT,
  MemberRank.GANGSTER,
  MemberRank.YOUNG_OG,
  MemberRank.BIG,
  MemberRank.OG,
] as const;

/** Rank assegnato di default quando un utente entra nella gang. */
export const DEFAULT_INITIAL_RANK: MemberRank = MemberRank.RESIDENT;

/** Etichette con emoji, per gli embed. */
export const RANK_LABEL: Readonly<Record<MemberRank, string>> = {
  [MemberRank.RESIDENT]: '🏠 Resident',
  [MemberRank.GANGSTER]: '🥷 Gangster',
  [MemberRank.YOUNG_OG]: '🩸 Young OG',
  [MemberRank.BIG]: '💎 Big',
  [MemberRank.OG]: '👑 OG',
};

/** Indice di un rank nella gerarchia (0 = RESIDENT). */
export function rankIndex(rank: MemberRank): number {
  const index = RANK_ORDER.indexOf(rank);
  /* c8 ignore next 3 -- irraggiungibile: MemberRank e' esaustivo in RANK_ORDER */
  if (index === -1) {
    throw new Error(`Rank fuori dalla gerarchia: ${rank}`);
  }
  return index;
}

/**
 * Confronta due rank.
 * @returns `> 0` se `a` e' superiore a `b`, `< 0` se inferiore, `0` se uguali.
 */
export function compareRanks(a: MemberRank, b: MemberRank): number {
  return rankIndex(a) - rankIndex(b);
}

/** Rank immediatamente superiore, o `undefined` se gia' al vertice (OG). */
export function nextRank(rank: MemberRank): MemberRank | undefined {
  return RANK_ORDER[rankIndex(rank) + 1];
}

/** Rank immediatamente inferiore, o `undefined` se gia' al minimo (RESIDENT). */
export function previousRank(rank: MemberRank): MemberRank | undefined {
  const index = rankIndex(rank);
  return index === 0 ? undefined : RANK_ORDER[index - 1];
}

/** Colori degli embed, per stato dell'operazione. */
export const EMBED_COLOR = {
  brand: 0x8b0000,
  success: 0x2ecc71,
  warning: 0xf1c40f,
  danger: 0xe74c3c,
  info: 0x3498db,
  neutral: 0x2b2d31,
} as const;

/** Limiti dell'API Discord che il codice deve rispettare. */
export const DISCORD_LIMITS = {
  embedDescription: 4096,
  embedFieldValue: 1024,
  embedFields: 25,
  embedTotal: 6000,
  selectOptions: 25,
  modalInputMax: 4000,
  autocompleteChoices: 25,
} as const;
