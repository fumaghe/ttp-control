/*
 * Prisma CLI configuration (Prisma ORM 7).
 *
 * In Prisma 7 la `datasource` nello schema NON contiene piu' `url` ne'
 * `directUrl`: la connection string usata dalla CLI (migrate / db pull /
 * studio) vive qui.
 *
 * Neon espone due endpoint:
 *   - POOLED   (host "...-pooler...")  -> usato a RUNTIME dal bot
 *   - DIRECT   (host senza "-pooler")  -> usato dalla CLI per il DDL
 *
 * Le migration devono passare dall'endpoint diretto, quindi qui preferiamo
 * DIRECT_URL e ricadiamo su DATABASE_URL solo se non e' configurato.
 */
import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// Volutamente NON lanciamo se manca: `prisma generate` deve funzionare anche
// senza database (build in CI / Docker, dove .env non e' presente).
// Sono i comandi che toccano davvero il DB (migrate, db pull, studio) a
// fallire con un messaggio esplicito della CLI se l'URL non c'e'.
const migrationUrl = process.env['DIRECT_URL'] ?? process.env['DATABASE_URL'];

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  // `exactOptionalPropertyTypes` non ammette `url: undefined`, quindi la
  // chiave viene omessa del tutto quando non c'e' una connection string.
  ...(migrationUrl ? { datasource: { url: migrationUrl } } : {}),
});
