-- =============================================================================
-- Rimuove il rank BIG introdotto per errore dalla gerarchia a nove livelli.
-- Il BIG storico della V1 era già stato rinominato correttamente BIG_HOMIE.
-- =============================================================================
-- Non esiste una conversione semanticamente corretta per un eventuale nuovo
-- BIG: promuoverlo a BIG_HOMIE o retrocederlo a ORIGINAL_TINY_LOC cambierebbe
-- privilegi e storico. Per questo la migration si ferma se trova riferimenti,
-- invece di riscriverli in silenzio.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "members" WHERE "rank" = 'BIG'::"MemberRank")
    OR EXISTS (SELECT 1 FROM "ttp_applications" WHERE "initialRank" = 'BIG'::"MemberRank")
    OR EXISTS (
      SELECT 1 FROM "member_history"
      WHERE "fromRank" = 'BIG'::"MemberRank" OR "toRank" = 'BIG'::"MemberRank"
    )
  THEN
    RAISE EXCEPTION 'Impossibile rimuovere MemberRank.BIG: esistono record che lo referenziano';
  END IF;
END $$;

-- PostgreSQL non supporta DROP VALUE su un enum: si ricrea il tipo con gli
-- otto valori corretti, preservando tutte le colonne e gli indici esistenti.
ALTER TABLE "members" ALTER COLUMN "rank" TYPE TEXT USING "rank"::TEXT;
ALTER TABLE "ttp_applications" ALTER COLUMN "initialRank" TYPE TEXT USING "initialRank"::TEXT;
ALTER TABLE "member_history" ALTER COLUMN "fromRank" TYPE TEXT USING "fromRank"::TEXT;
ALTER TABLE "member_history" ALTER COLUMN "toRank" TYPE TEXT USING "toRank"::TEXT;

ALTER TYPE "MemberRank" RENAME TO "MemberRank_with_big";
CREATE TYPE "MemberRank" AS ENUM (
  'RESIDENT',
  'GANG_BANGER',
  'INFANTIL_LOC',
  'TINY_LOC',
  'LOC',
  'ORIGINAL_TINY_LOC',
  'BIG_HOMIE',
  'OG'
);

ALTER TABLE "members"
  ALTER COLUMN "rank" TYPE "MemberRank" USING "rank"::"MemberRank";
ALTER TABLE "ttp_applications"
  ALTER COLUMN "initialRank" TYPE "MemberRank" USING "initialRank"::"MemberRank";
ALTER TABLE "member_history"
  ALTER COLUMN "fromRank" TYPE "MemberRank" USING "fromRank"::"MemberRank";
ALTER TABLE "member_history"
  ALTER COLUMN "toRank" TYPE "MemberRank" USING "toRank"::"MemberRank";

DROP TYPE "MemberRank_with_big";
