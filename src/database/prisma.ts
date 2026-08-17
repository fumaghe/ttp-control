/**
 * Prisma Client + driver adapter PostgreSQL.
 *
 * In Prisma 7 il client richiede un driver adapter esplicito. Usiamo
 * `@prisma/adapter-pg` (driver `pg` su TCP) perche' il bot e' un processo
 * long-running: un pool di connessioni reali e' la scelta corretta.
 * `@prisma/adapter-neon` (WebSocket) avrebbe senso solo su serverless/edge.
 *
 * La connection string e' quella POOLED di Neon: il pooler regge molte
 * connessioni brevi ed e' l'endpoint giusto per il runtime. Le migration
 * usano invece l'endpoint diretto, configurato in `prisma.config.ts`.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { createLogger } from '../utils/logger.js';
import { sanitizeDatabaseUrl } from '../utils/redact.js';

const log = createLogger('database');

export type Database = PrismaClient;

let client: PrismaClient | undefined;

export interface DatabaseOptions {
  readonly databaseUrl: string;
  /** Log delle query: utile in sviluppo, rumoroso e costoso in produzione. */
  readonly logQueries?: boolean;
}

/**
 * Crea il Prisma Client. Va chiamata una volta sola allo startup;
 * il risultato viene riusato da `getDatabase()`.
 */
export function createDatabase(options: DatabaseOptions): PrismaClient {
  const adapter = new PrismaPg({ connectionString: options.databaseUrl });

  const prisma = new PrismaClient({
    adapter,
    log: options.logQueries
      ? [
          { emit: 'event', level: 'query' },
          { emit: 'event', level: 'warn' },
          { emit: 'event', level: 'error' },
        ]
      : [
          { emit: 'event', level: 'warn' },
          { emit: 'event', level: 'error' },
        ],
  });

  if (options.logQueries) {
    prisma.$on('query', (event) => {
      log.debug({ durationMs: event.duration, query: event.query }, 'query');
    });
  }
  prisma.$on('warn', (event) => {
    log.warn({ target: event.target }, event.message);
  });
  prisma.$on('error', (event) => {
    log.error({ target: event.target }, event.message);
  });

  client = prisma;
  return prisma;
}

/** Il client gia' creato. Errore esplicito se lo startup non l'ha inizializzato. */
export function getDatabase(): PrismaClient {
  if (!client) {
    throw new Error('Database non inizializzato: chiama createDatabase() allo startup.');
  }
  return client;
}

/** Oltre questa soglia lo startup fallisce invece di restare appeso. */
const CONNECT_TIMEOUT_MS = 15_000;

/**
 * Verifica che il database risponda davvero.
 *
 * Il timeout esplicito e' importante: senza, un problema di rete o un
 * security group chiuso lascerebbero il processo bloccato per sempre in
 * avvio, senza log e senza che il process manager se ne accorga. Meglio un
 * crash immediato e un restart.
 *
 * Logga solo `host/database`: mai la connection string completa.
 */
export async function connectDatabase(
  prisma: PrismaClient,
  databaseUrl: string,
): Promise<{ latencyMs: number }> {
  const startedAt = Date.now();

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `Database non raggiungibile entro ${CONNECT_TIMEOUT_MS / 1000}s (${sanitizeDatabaseUrl(databaseUrl)}). ` +
            'Controlla DATABASE_URL, lo stato del progetto Neon e la connettività di rete.',
        ),
      );
    }, CONNECT_TIMEOUT_MS);
  });

  try {
    await Promise.race([prisma.$queryRaw`SELECT 1`, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }

  const latencyMs = Date.now() - startedAt;
  log.info({ database: sanitizeDatabaseUrl(databaseUrl), latencyMs }, 'Database connesso');
  return { latencyMs };
}

/** Misura la latenza del database senza lanciare: usata da `/ping` e `/setup`. */
export async function pingDatabase(
  prisma: PrismaClient,
): Promise<{ ok: true; latencyMs: number } | { ok: false; error: string }> {
  const startedAt = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'errore sconosciuto' };
  }
}

export async function disconnectDatabase(): Promise<void> {
  if (!client) return;
  await client.$disconnect();
  client = undefined;
  log.info('Database disconnesso');
}
