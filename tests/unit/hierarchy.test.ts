import { describe, expect, it } from 'vitest';
import { DEFAULT_INITIAL_RANK, RANK_ORDER } from '../../src/config/constants.js';

/**
 * Phase 0 — smoke test della toolchain e delle invarianti di gerarchia
 * gia' definite. La suite completa richiesta al punto 68 del master prompt
 * arriva insieme ai service delle fasi successive.
 */
describe('TTP hierarchy', () => {
  it('espone i cinque rank nell ordine RESIDENT -> OG', () => {
    expect([...RANK_ORDER]).toEqual(['RESIDENT', 'GANGSTER', 'YOUNG_OG', 'BIG', 'OG']);
  });

  it('usa RESIDENT come rank iniziale di default', () => {
    expect(DEFAULT_INITIAL_RANK).toBe('RESIDENT');
    expect(RANK_ORDER[0]).toBe(DEFAULT_INITIAL_RANK);
  });

  it('non contiene rank duplicati', () => {
    expect(new Set(RANK_ORDER).size).toBe(RANK_ORDER.length);
  });
});
