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

/**
 * La gerarchia attesa, scritta per esteso e a mano.
 *
 * Volutamente NON derivata da `RANK_ORDER`: se lo fosse, il test passerebbe
 * anche riordinando la gerarchia per sbaglio. Qui l'elenco letterale E' la
 * specifica, e `RANK_ORDER` deve adeguarsi a lui.
 */
const EXPECTED_ORDER = [
  'RESIDENT',
  'GANG_BANGER',
  'INFANTIL_LOC',
  'TINY_LOC',
  'LOC',
  'ORIGINAL_TINY_LOC',
  'BIG',
  'BIG_HOMIE',
  'OG',
] as const;

describe('gerarchia TTP', () => {
  it('espone i nove rank nell’ordine RESIDENT → OG', () => {
    expect([...RANK_ORDER]).toEqual([...EXPECTED_ORDER]);
  });

  it('copre esattamente i valori dell’enum MemberRank, senza avanzi', () => {
    // Se qualcuno aggiunge un rank allo schema Prisma e si dimentica di
    // RANK_ORDER, il bot avrebbe un rank che non sa ordinare: qui si ferma.
    expect([...RANK_ORDER].sort()).toEqual(Object.values(MemberRank).sort());
  });

  it('usa RESIDENT come rank iniziale di default', () => {
    expect(DEFAULT_INITIAL_RANK).toBe(MemberRank.RESIDENT);
    expect(RANK_ORDER[0]).toBe(DEFAULT_INITIAL_RANK);
  });

  it('mette OG in cima', () => {
    expect(RANK_ORDER.at(-1)).toBe(MemberRank.OG);
  });

  it('non contiene rank duplicati', () => {
    expect(new Set(RANK_ORDER).size).toBe(RANK_ORDER.length);
  });

  it('ha un’etichetta non vuota per ogni rank', () => {
    for (const rank of RANK_ORDER) {
      expect(RANK_LABEL[rank]).toBeTruthy();
    }
  });

  it('usa etichette leggibili che nominano il rank', () => {
    expect(RANK_LABEL[MemberRank.RESIDENT]).toContain('Resident');
    expect(RANK_LABEL[MemberRank.GANG_BANGER]).toContain('Gang Banger');
    expect(RANK_LABEL[MemberRank.INFANTIL_LOC]).toContain('Infantil Loc');
    expect(RANK_LABEL[MemberRank.TINY_LOC]).toContain('Tiny Loc');
    expect(RANK_LABEL[MemberRank.LOC]).toContain('Loc');
    expect(RANK_LABEL[MemberRank.ORIGINAL_TINY_LOC]).toContain('Original Tiny Loc');
    expect(RANK_LABEL[MemberRank.BIG]).toContain('Big');
    expect(RANK_LABEL[MemberRank.BIG_HOMIE]).toContain('Big Homie');
    expect(RANK_LABEL[MemberRank.OG]).toContain('OG');
  });

  it('non nomina più i rank della vecchia gerarchia', () => {
    const labels = Object.values(RANK_LABEL).join(' ');
    expect(labels).not.toContain('Gangster');
    expect(labels).not.toContain('Young OG');
  });
});

describe('nextRank', () => {
  it('avanza di una posizione alla volta lungo tutta la scala', () => {
    expect(nextRank(MemberRank.RESIDENT)).toBe(MemberRank.GANG_BANGER);
    expect(nextRank(MemberRank.GANG_BANGER)).toBe(MemberRank.INFANTIL_LOC);
    expect(nextRank(MemberRank.INFANTIL_LOC)).toBe(MemberRank.TINY_LOC);
    expect(nextRank(MemberRank.TINY_LOC)).toBe(MemberRank.LOC);
    expect(nextRank(MemberRank.LOC)).toBe(MemberRank.ORIGINAL_TINY_LOC);
    expect(nextRank(MemberRank.ORIGINAL_TINY_LOC)).toBe(MemberRank.BIG);
    expect(nextRank(MemberRank.BIG)).toBe(MemberRank.BIG_HOMIE);
    expect(nextRank(MemberRank.BIG_HOMIE)).toBe(MemberRank.OG);
  });

  it('non supera OG', () => {
    expect(nextRank(MemberRank.OG)).toBeUndefined();
  });

  it('serve otto promote per andare da RESIDENT a OG', () => {
    let rank: MemberRank = MemberRank.RESIDENT;
    let steps = 0;
    for (let next = nextRank(rank); next !== undefined; next = nextRank(rank)) {
      rank = next;
      steps += 1;
    }
    expect(rank).toBe(MemberRank.OG);
    expect(steps).toBe(8);
  });
});

describe('previousRank', () => {
  it('retrocede di una posizione alla volta lungo tutta la scala', () => {
    expect(previousRank(MemberRank.OG)).toBe(MemberRank.BIG_HOMIE);
    expect(previousRank(MemberRank.BIG_HOMIE)).toBe(MemberRank.BIG);
    expect(previousRank(MemberRank.BIG)).toBe(MemberRank.ORIGINAL_TINY_LOC);
    expect(previousRank(MemberRank.ORIGINAL_TINY_LOC)).toBe(MemberRank.LOC);
    expect(previousRank(MemberRank.LOC)).toBe(MemberRank.TINY_LOC);
    expect(previousRank(MemberRank.TINY_LOC)).toBe(MemberRank.INFANTIL_LOC);
    expect(previousRank(MemberRank.INFANTIL_LOC)).toBe(MemberRank.GANG_BANGER);
    expect(previousRank(MemberRank.GANG_BANGER)).toBe(MemberRank.RESIDENT);
  });

  it('non scende sotto RESIDENT', () => {
    expect(previousRank(MemberRank.RESIDENT)).toBeUndefined();
  });

  it('next e previous sono inversi su ogni gradino', () => {
    for (const rank of RANK_ORDER) {
      const up = nextRank(rank);
      if (up) expect(previousRank(up)).toBe(rank);
      const down = previousRank(rank);
      if (down) expect(nextRank(down)).toBe(rank);
    }
  });
});

describe('compareRanks', () => {
  it('ordina secondo la gerarchia', () => {
    expect(compareRanks(MemberRank.OG, MemberRank.BIG_HOMIE)).toBeGreaterThan(0);
    expect(compareRanks(MemberRank.BIG_HOMIE, MemberRank.BIG)).toBeGreaterThan(0);
    expect(compareRanks(MemberRank.RESIDENT, MemberRank.GANG_BANGER)).toBeLessThan(0);
    expect(compareRanks(MemberRank.BIG, MemberRank.BIG)).toBe(0);
  });

  it('non si fa ingannare dall’ordine alfabetico', () => {
    // In ordine alfabetico 'BIG' < 'BIG_HOMIE' e 'LOC' < 'TINY_LOC': la
    // seconda è l'opposto della gerarchia. Ecco perché nel codice non si
    // confrontano mai i rank come stringhe.
    expect(compareRanks(MemberRank.LOC, MemberRank.TINY_LOC)).toBeGreaterThan(0);
    // …mentre in ordine alfabetico è l'opposto:
    expect([MemberRank.TINY_LOC, MemberRank.LOC].sort()).toEqual([
      MemberRank.LOC,
      MemberRank.TINY_LOC,
    ]);
  });

  it('è coerente con rankIndex su tutta la scala', () => {
    expect(rankIndex(MemberRank.RESIDENT)).toBe(0);
    expect(rankIndex(MemberRank.OG)).toBe(RANK_ORDER.length - 1);
    expect(RANK_ORDER.length).toBe(9);

    RANK_ORDER.forEach((rank, index) => {
      expect(rankIndex(rank)).toBe(index);
    });
  });
});
