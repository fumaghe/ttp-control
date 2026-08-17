/**
 * La migration della gerarchia, verificata sul SQL che verrà davvero eseguito.
 *
 * Perché un test e non solo una prova a mano: la mappatura dei rank legacy non
 * è deducibile dai nomi. `GANGSTER` diventa `TINY_LOC` e `BIG` diventa
 * `BIG_HOMIE` perché i RUOLI DISCORD sono stati riutilizzati — e nella nuova
 * gerarchia esiste un `BIG` diverso, più in basso, con un ruolo nuovo. Chi
 * dovesse "correggere" la migration mappando `BIG → BIG` romperebbe
 * l'allineamento fra database e Discord per ogni ex Big della gang, in
 * silenzio. Questo test è lì per fermarlo.
 *
 * L'esecuzione vera del SQL su PostgreSQL non avviene qui — richiederebbe un
 * database nel runner. Qui si verifica il CONTENUTO e soprattutto l'ORDINE
 * delle istruzioni, che è la parte in cui è facile sbagliare.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MemberRank } from '../../src/generated/prisma/enums.js';
import { RANK_ORDER } from '../../src/config/constants.js';

const MIGRATION = readFileSync(
  fileURLToPath(
    new URL(
      '../../prisma/migrations/20260818000000_nine_rank_hierarchy/migration.sql',
      import.meta.url,
    ),
  ),
  'utf8',
);

/** Solo le istruzioni eseguibili: i commenti spiegano, non migrano. */
const STATEMENTS = MIGRATION.split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith('--'));

/** Posizione della prima istruzione che contiene tutti i frammenti dati. */
function indexOfStatement(...fragments: string[]): number {
  return STATEMENTS.findIndex((statement) =>
    fragments.every((fragment) => statement.includes(fragment)),
  );
}

/**
 * L'equivalenza voluta fra vecchia e nuova gerarchia.
 *
 * Segue i ruoli Discord riutilizzati, non l'assonanza dei nomi.
 */
const LEGACY_MAPPING = [
  ['RESIDENT', 'RESIDENT'],
  ['GANGSTER', 'TINY_LOC'],
  ['YOUNG_OG', 'ORIGINAL_TINY_LOC'],
  ['BIG', 'BIG_HOMIE'],
  ['OG', 'OG'],
] as const;

describe('mappatura dei rank legacy', () => {
  it('rinomina i tre valori che cambiano nome, e solo quelli', () => {
    const renames = STATEMENTS.filter((s) => s.includes('RENAME VALUE'));
    expect(renames).toHaveLength(3);

    for (const [legacy, current] of LEGACY_MAPPING) {
      if (legacy === current) continue;
      expect(renames).toContainEqual(
        `ALTER TYPE "MemberRank" RENAME VALUE '${legacy}' TO '${current}';`,
      );
    }
  });

  it('lascia RESIDENT e OG intatti', () => {
    expect(MIGRATION).not.toContain("RENAME VALUE 'RESIDENT'");
    expect(MIGRATION).not.toContain("RENAME VALUE 'OG'");
  });

  it('il vecchio BIG diventa BIG_HOMIE, MAI il nuovo BIG', () => {
    // Il punto singolo più pericoloso dell'intera migrazione.
    expect(MIGRATION).toContain("RENAME VALUE 'BIG' TO 'BIG_HOMIE';");
    expect(MIGRATION).not.toContain("RENAME VALUE 'BIG' TO 'BIG';");
    expect(MIGRATION).not.toContain('UPDATE members');
  });

  it('ogni rank della vecchia gerarchia ha una destinazione valida', () => {
    for (const [, current] of LEGACY_MAPPING) {
      expect(Object.values(MemberRank)).toContain(current);
      expect(RANK_ORDER).toContain(current);
    }
  });

  it('la mappatura non fa collidere due rank legacy sullo stesso valore', () => {
    const destinations = LEGACY_MAPPING.map(([, current]) => current);
    expect(new Set(destinations).size).toBe(destinations.length);
  });
});

describe('nuovi valori dell’enum', () => {
  it('aggiunge esattamente i quattro rank che prima non esistevano', () => {
    const added = STATEMENTS.filter((s) => s.includes('ADD VALUE'));
    expect(added).toHaveLength(4);

    for (const rank of ['GANG_BANGER', 'INFANTIL_LOC', 'LOC', 'BIG']) {
      expect(added.some((s) => s.includes(`ADD VALUE '${rank}'`))).toBe(true);
    }
  });

  it('rinomina BIG PRIMA di aggiungere il nuovo BIG', () => {
    // All'inverso il valore 'BIG' sarebbe duplicato e l'ALTER TYPE fallirebbe:
    // è una dipendenza d'ordine, non uno stile.
    const rename = indexOfStatement('RENAME VALUE', "'BIG'", "'BIG_HOMIE'");
    const add = indexOfStatement('ADD VALUE', "'BIG'");

    expect(rename).toBeGreaterThanOrEqual(0);
    expect(add).toBeGreaterThanOrEqual(0);
    expect(rename).toBeLessThan(add);
  });

  it('posiziona ogni nuovo valore accanto al rank giusto', () => {
    expect(MIGRATION).toContain("ADD VALUE 'GANG_BANGER' AFTER 'RESIDENT'");
    expect(MIGRATION).toContain("ADD VALUE 'INFANTIL_LOC' AFTER 'GANG_BANGER'");
    expect(MIGRATION).toContain("ADD VALUE 'LOC' AFTER 'TINY_LOC'");
    expect(MIGRATION).toContain("ADD VALUE 'BIG' AFTER 'ORIGINAL_TINY_LOC'");
  });

  it('l’ordinamento risultante dell’enum coincide con RANK_ORDER', () => {
    // Si ricostruisce l'enum applicando le istruzioni della migration a mano,
    // partendo dai cinque valori della V1.
    const values = ['RESIDENT', 'GANGSTER', 'YOUNG_OG', 'BIG', 'OG'];

    for (const statement of STATEMENTS) {
      const rename = /RENAME VALUE '(\w+)' TO '(\w+)'/.exec(statement);
      if (rename?.[1] && rename[2]) {
        values[values.indexOf(rename[1])] = rename[2];
        continue;
      }
      const add = /ADD VALUE '(\w+)' AFTER '(\w+)'/.exec(statement);
      if (add?.[1] && add[2]) {
        values.splice(values.indexOf(add[2]) + 1, 0, add[1]);
      }
    }

    expect(values).toEqual([...RANK_ORDER]);
  });
});

describe('la migration non è distruttiva', () => {
  it('non contiene istruzioni che cancellano o riscrivono dati', () => {
    for (const forbidden of [
      'DROP TYPE',
      'DROP TABLE',
      'DROP COLUMN',
      'DELETE FROM',
      'TRUNCATE',
      'UPDATE ',
    ]) {
      expect(STATEMENTS.some((s) => s.toUpperCase().includes(forbidden))).toBe(false);
    }
  });

  it('tocca solo il tipo MemberRank', () => {
    for (const statement of STATEMENTS) {
      expect(statement).toContain('ALTER TYPE "MemberRank"');
    }
  });

  it('non ricrea Member né azzera MemberHistory', () => {
    // Sulle sole istruzioni: i commenti nominano `member_history` proprio per
    // spiegare che lo storico NON viene toccato.
    for (const table of ['members', 'member_history', 'ttp_applications']) {
      expect(STATEMENTS.some((s) => s.includes(table))).toBe(false);
    }
    expect(STATEMENTS.some((s) => s.includes('CREATE TABLE'))).toBe(false);
  });
});
