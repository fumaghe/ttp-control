/**
 * Protezioni della migration che elimina il rank intermedio BIG.
 *
 * PostgreSQL non permette di cancellare direttamente un valore enum: la
 * migration ricrea il tipo. Prima, però, deve fermarsi se un dato corrente o
 * storico usa BIG. Scegliere automaticamente fra ORIGINAL_TINY_LOC e
 * BIG_HOMIE altererebbe grado, permessi o storico senza una decisione umana.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MIGRATION = readFileSync(
  fileURLToPath(
    new URL(
      '../../prisma/migrations/20260913020000_remove_big_rank/migration.sql',
      import.meta.url,
    ),
  ),
  'utf8',
);

const CURRENT_RANKS = [
  'RESIDENT',
  'GANG_BANGER',
  'INFANTIL_LOC',
  'TINY_LOC',
  'LOC',
  'ORIGINAL_TINY_LOC',
  'BIG_HOMIE',
  'OG',
] as const;

describe('migration di rimozione BIG', () => {
  it('si blocca se BIG è referenziato in dati correnti o storici', () => {
    expect(MIGRATION).toContain(`FROM "members" WHERE "rank" = 'BIG'::"MemberRank"`);
    expect(MIGRATION).toContain(
      `FROM "ttp_applications" WHERE "initialRank" = 'BIG'::"MemberRank"`,
    );
    expect(MIGRATION).toContain(`"fromRank" = 'BIG'::"MemberRank"`);
    expect(MIGRATION).toContain(`"toRank" = 'BIG'::"MemberRank"`);
    expect(MIGRATION).toContain('RAISE EXCEPTION');
  });

  it('ricrea MemberRank con gli otto valori voluti e senza BIG', () => {
    const created = /CREATE TYPE "MemberRank" AS ENUM \(([^)]+)\)/s.exec(MIGRATION)?.[1];
    expect(created).toBeTruthy();

    const values = [...(created?.matchAll(/'([A-Z_]+)'/g) ?? [])].map((match) => match[1]);
    expect(values).toEqual([...CURRENT_RANKS]);
    expect(values).not.toContain('BIG');
  });

  it('converte tutte le colonne che usano MemberRank', () => {
    for (const column of ['rank', 'initialRank', 'fromRank', 'toRank']) {
      expect(MIGRATION.match(new RegExp(`ALTER COLUMN "${column}"`, 'g'))).toHaveLength(2);
    }
  });

  it('non converte silenziosamente nessun record', () => {
    expect(MIGRATION).not.toMatch(/\bUPDATE\b/i);
    expect(MIGRATION).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(MIGRATION).not.toMatch(/\bTRUNCATE\b/i);
  });

  it('elimina soltanto il vecchio tipo enum dopo la riconversione', () => {
    expect(MIGRATION).toContain('ALTER TYPE "MemberRank" RENAME TO "MemberRank_with_big"');
    expect(MIGRATION).toContain('DROP TYPE "MemberRank_with_big"');
    expect(MIGRATION).not.toContain('DROP TABLE');
    expect(MIGRATION).not.toContain('DROP COLUMN');
  });
});
