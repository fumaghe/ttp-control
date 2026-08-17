import { describe, expect, it } from 'vitest';
import { MemberRank } from '../../src/generated/prisma/enums.js';
import {
  compareRanks,
  DEFAULT_INITIAL_RANK,
  nextRank,
  previousRank,
  RANK_LABEL,
  RANK_ORDER,
  rankIndex,
} from '../../src/config/constants.js';

describe('gerarchia TTP', () => {
  it('espone i cinque rank nell’ordine RESIDENT → OG', () => {
    expect([...RANK_ORDER]).toEqual([
      MemberRank.RESIDENT,
      MemberRank.GANGSTER,
      MemberRank.YOUNG_OG,
      MemberRank.BIG,
      MemberRank.OG,
    ]);
  });

  it('usa RESIDENT come rank iniziale di default', () => {
    expect(DEFAULT_INITIAL_RANK).toBe(MemberRank.RESIDENT);
    expect(RANK_ORDER[0]).toBe(DEFAULT_INITIAL_RANK);
  });

  it('non contiene rank duplicati', () => {
    expect(new Set(RANK_ORDER).size).toBe(RANK_ORDER.length);
  });

  it('ha un’etichetta per ogni rank', () => {
    for (const rank of RANK_ORDER) {
      expect(RANK_LABEL[rank]).toBeTruthy();
    }
  });
});

describe('nextRank / previousRank', () => {
  it('avanza di una posizione alla volta', () => {
    expect(nextRank(MemberRank.RESIDENT)).toBe(MemberRank.GANGSTER);
    expect(nextRank(MemberRank.GANGSTER)).toBe(MemberRank.YOUNG_OG);
    expect(nextRank(MemberRank.YOUNG_OG)).toBe(MemberRank.BIG);
    expect(nextRank(MemberRank.BIG)).toBe(MemberRank.OG);
  });

  it('non supera OG', () => {
    expect(nextRank(MemberRank.OG)).toBeUndefined();
  });

  it('retrocede di una posizione alla volta', () => {
    expect(previousRank(MemberRank.OG)).toBe(MemberRank.BIG);
    expect(previousRank(MemberRank.GANGSTER)).toBe(MemberRank.RESIDENT);
  });

  it('non scende sotto RESIDENT', () => {
    expect(previousRank(MemberRank.RESIDENT)).toBeUndefined();
  });

  it('next e previous sono inversi', () => {
    for (const rank of RANK_ORDER) {
      const up = nextRank(rank);
      if (up) expect(previousRank(up)).toBe(rank);
    }
  });
});

describe('compareRanks', () => {
  it('ordina correttamente', () => {
    expect(compareRanks(MemberRank.OG, MemberRank.BIG)).toBeGreaterThan(0);
    expect(compareRanks(MemberRank.RESIDENT, MemberRank.GANGSTER)).toBeLessThan(0);
    expect(compareRanks(MemberRank.BIG, MemberRank.BIG)).toBe(0);
  });

  it('rankIndex è coerente con l’ordine', () => {
    expect(rankIndex(MemberRank.RESIDENT)).toBe(0);
    expect(rankIndex(MemberRank.OG)).toBe(RANK_ORDER.length - 1);
  });
});
