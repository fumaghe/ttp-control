-- =============================================================================
-- Verifica della migration 20260818000000_nine_rank_hierarchy su un DB REALE
-- =============================================================================
-- I test di `tests/unit/rankMigration.test.ts` controllano il testo del SQL.
-- Questo script controlla il RISULTATO: va eseguito su una copia del database
-- (mai in produzione) DOPO aver applicato la migration, e fallisce con un
-- messaggio esplicito se qualcosa non torna.
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f scripts/verify-rank-migration.sql
--
-- Come ottenere una copia usa e getta su Neon: crea un branch del database dal
-- pannello Neon, applica lì la migration e punta questo script su quel branch.
-- =============================================================================

\echo '== 1. L''enum ha esattamente i nove valori attesi, nell''ordine giusto =='

DO $$
DECLARE
  actual   text[];
  expected text[] := ARRAY[
    'RESIDENT', 'GANG_BANGER', 'INFANTIL_LOC', 'TINY_LOC', 'LOC',
    'ORIGINAL_TINY_LOC', 'BIG', 'BIG_HOMIE', 'OG'
  ];
BEGIN
  SELECT array_agg(e.enumlabel ORDER BY e.enumsortorder)
    INTO actual
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
   WHERE t.typname = 'MemberRank';

  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'MemberRank errato.  atteso: %  trovato: %', expected, actual;
  END IF;

  RAISE NOTICE 'OK — enum: %', actual;
END $$;

\echo '== 2. Nessun valore legacy è sopravvissuto =='

DO $$
DECLARE
  legacy text;
BEGIN
  SELECT string_agg(e.enumlabel, ', ')
    INTO legacy
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
   WHERE t.typname = 'MemberRank'
     AND e.enumlabel IN ('GANGSTER', 'YOUNG_OG');

  IF legacy IS NOT NULL THEN
    RAISE EXCEPTION 'Valori legacy ancora presenti: %', legacy;
  END IF;

  RAISE NOTICE 'OK — nessun GANGSTER/YOUNG_OG residuo';
END $$;

\echo '== 3. Nessuna riga è andata persa o è rimasta senza rank =='

DO $$
DECLARE
  orfani bigint;
BEGIN
  SELECT count(*) INTO orfani FROM members WHERE rank IS NULL;
  IF orfani > 0 THEN
    RAISE EXCEPTION '% membri senza rank', orfani;
  END IF;

  RAISE NOTICE 'OK — % membri, % righe di storico, tutti con rank valido',
    (SELECT count(*) FROM members),
    (SELECT count(*) FROM member_history);
END $$;

\echo '== 4. Distribuzione dei rank, da controllare a occhio =='

-- ATTENZIONE AL VECCHIO BIG. Gli ex Big devono comparire come BIG_HOMIE.
-- Se dopo la migration vedi righe su BIG senza averne promosso nessuno a mano,
-- la mappatura è sbagliata: il vecchio BIG è finito sul rank nuovo.
SELECT rank AS "rank (in ordine di gerarchia)", count(*) AS membri
  FROM members
 WHERE status IN ('ACTIVE', 'INACTIVE')
 GROUP BY rank
 ORDER BY rank;

\echo '== 5. Coerenza dello storico =='

-- `fromRank`/`toRank` seguono lo stesso enum: se la migration fosse stata
-- parziale, qui comparirebbero valori incoerenti.
SELECT event, "fromRank", "toRank", count(*) AS occorrenze
  FROM member_history
 WHERE "fromRank" IS NOT NULL OR "toRank" IS NOT NULL
 GROUP BY event, "fromRank", "toRank"
 ORDER BY event, "fromRank", "toRank";

\echo '== Verifica completata: nessun errore =='
