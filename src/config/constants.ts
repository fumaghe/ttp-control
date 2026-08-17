/**
 * Costanti di dominio stabili, non configurabili via env.
 *
 * Regola: gli ID Discord (ruoli, canali, guild) NON stanno qui.
 * Vivono in `.env` e vengono esposti tipizzati da `src/config/env.ts` (Phase 1).
 */

export const BOT_NAME = 'TTP Control';
export const BOT_VERSION = '0.1.0';

/** Nome della gang, usato negli embed. */
export const GANG_NAME = 'TTP — Impero';

/**
 * Gerarchia TTP in ordine crescente.
 *
 * `promote` avanza di una posizione, `demote` retrocede di una.
 * L'ordine di questo array e' l'unica fonte di verita' sulla gerarchia:
 * non duplicarlo altrove.
 */
export const RANK_ORDER = ['RESIDENT', 'GANGSTER', 'YOUNG_OG', 'BIG', 'OG'] as const;

export type RankName = (typeof RANK_ORDER)[number];

/** Rank assegnato di default quando un utente entra nella gang. */
export const DEFAULT_INITIAL_RANK: RankName = 'RESIDENT';
