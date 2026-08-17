-- =============================================================================
-- TTP CONTROL — gerarchia a nove rank
-- =============================================================================
-- Porta `MemberRank` da cinque a nove valori:
--
--   PRIMA   RESIDENT, GANGSTER, YOUNG_OG, BIG, OG
--   DOPO    RESIDENT, GANG_BANGER, INFANTIL_LOC, TINY_LOC, LOC,
--           ORIGINAL_TINY_LOC, BIG, BIG_HOMIE, OG
--
-- MIGRAZIONE NON DISTRUTTIVA. Nessuna riga viene toccata: si rinominano i
-- VALORI dell'enum, quindi ogni `members.rank`, `member_history.fromRank`,
-- `member_history.toRank` e `ttp_applications.initialRank` gia' esistente
-- resta esattamente dov'era e cambia solo etichetta.
--
-- L'EQUIVALENZA E' VOLUTA e segue i ruoli Discord, non i nomi:
--
--   RESIDENT  -> RESIDENT            (invariato)
--   GANGSTER  -> TINY_LOC            stesso ruolo Discord, rinominato
--   YOUNG_OG  -> ORIGINAL_TINY_LOC   stesso ruolo Discord, rinominato
--   BIG       -> BIG_HOMIE           stesso ruolo Discord, rinominato
--   OG        -> OG                  (invariato)
--
-- ATTENZIONE AL VECCHIO `BIG`: NON diventa il nuovo `BIG`. Il nuovo `BIG` e'
-- un rank inedito con un ruolo Discord nuovo (ROLE_BIG_ID), inserito fra
-- ORIGINAL_TINY_LOC e BIG_HOMIE. Migrare il vecchio BIG sul nuovo BIG
-- produrrebbe membri il cui rank a database non corrisponde piu' al ruolo
-- Discord che hanno addosso.
--
-- ORDINE DELLE ISTRUZIONI. Il rename di BIG -> BIG_HOMIE deve precedere
-- l'aggiunta del nuovo BIG: al contrario il valore 'BIG' risulterebbe
-- duplicato e l'ALTER TYPE fallirebbe.
--
-- SINTASSI. `ALTER TYPE ... RENAME VALUE` esiste da PostgreSQL 10 e
-- `ALTER TYPE ... ADD VALUE ... BEFORE/AFTER` da PostgreSQL 9.1; su
-- PostgreSQL 12+ (Neon gira su 16/17) `ADD VALUE` e' ammesso dentro una
-- transazione — che e' come Prisma esegue le migration — purche' il nuovo
-- valore non venga USATO nella stessa transazione. Qui infatti non lo e':
-- questa migration non scrive su nessuna tabella.
-- =============================================================================

-- --- 1. Rinomina dei valori legacy -------------------------------------------
-- Le righe esistenti seguono il rename automaticamente: nessun UPDATE.
ALTER TYPE "MemberRank" RENAME VALUE 'GANGSTER' TO 'TINY_LOC';
ALTER TYPE "MemberRank" RENAME VALUE 'YOUNG_OG' TO 'ORIGINAL_TINY_LOC';
ALTER TYPE "MemberRank" RENAME VALUE 'BIG' TO 'BIG_HOMIE';

-- --- 2. Nuovi rank ------------------------------------------------------------
-- `BEFORE`/`AFTER` posizionano i valori nell'ordinamento interno dell'enum,
-- cosi' un `ORDER BY rank` in SQL segue la gerarchia dal basso verso l'alto.
ALTER TYPE "MemberRank" ADD VALUE 'GANG_BANGER' AFTER 'RESIDENT';
ALTER TYPE "MemberRank" ADD VALUE 'INFANTIL_LOC' AFTER 'GANG_BANGER';
ALTER TYPE "MemberRank" ADD VALUE 'LOC' AFTER 'TINY_LOC';
-- Il nuovo BIG: fra ORIGINAL_TINY_LOC e BIG_HOMIE, mai al posto del vecchio.
ALTER TYPE "MemberRank" ADD VALUE 'BIG' AFTER 'ORIGINAL_TINY_LOC';
