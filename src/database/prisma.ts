/**
 * Prisma Client + driver adapter PostgreSQL, sulla runtime dei Worker.
 *
 * SCELTA TECNICA (vedi anche README → "Database su Cloudflare"):
 * Prisma 7 con `@prisma/adapter-pg` e il client generato per `workerd`. Il
 * generatore emette un query compiler WebAssembly che wrangler impacchetta
 * come modulo: nessuna compilazione WASM a runtime, che su Workers sarebbe
 * vietata. È il percorso documentato da Prisma per Cloudflare ed è quello
 * che permette di NON riscrivere il repository layer: schema, migration e
 * query restano identici alla V1.
 *
 * CICLO DI VITA: un client PER INVOCAZIONE, non un singleton di modulo.
 * Su Workers gli oggetti di I/O non possono attraversare due richieste
 * diverse: un pool tenuto a livello di modulo verrebbe rifiutato dalla
 * runtime. Il pooling vero lo fa Hyperdrive, davanti a Neon.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { createLogger } from '../utils/logger.js';
import { sanitizeDatabaseUrl } from '../utils/redact.js';

const log = createLogger('database');

export type Database = PrismaClient;

export interface DatabaseOptions {
  readonly databaseUrl: string;
  /** Log delle query: utile in sviluppo, rumoroso e costoso in produzione. */
  readonly logQueries?: boolean;
}

/**
 * Crea un Prisma Client. Da chiamare una volta per invocazione del Worker.
 *
 * Il pool `pg` viene dimensionato a una sola connessione: davanti c'è
 * Hyperdrive, che gestisce lui il pooling verso Neon. Aprire più connessioni
 * per invocazione consumerebbe quota senza servire a nulla, dato che una
 * singola interaction esegue query in sequenza.
 */
export function createDatabase(options: DatabaseOptions): PrismaClient {
  const adapter = new PrismaPg({ connectionString: options.databaseUrl, max: 1 });

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

  return prisma;
}

/** Oltre questa soglia il controllo di raggiungibilita' fallisce. */
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * Verifica che il database risponda davvero.
 *
 * Il timeout esplicito e' importante: senza, un problema di rete lascerebbe
 * l'invocazione appesa fino al limite della runtime. Meglio un errore chiaro.
 *
 * Logga solo `host/database`: mai la connection string completa.
 */
export async function connectDatabase(
  prisma: PrismaClient,
  databaseUrl: string,
): Promise<{ latencyMs: number }> {
  const startedAt = Date.now();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `Database non raggiungibile entro ${CONNECT_TIMEOUT_MS / 1000}s (${sanitizeDatabaseUrl(databaseUrl)}). ` +
            'Controlla la configurazione Hyperdrive/DATABASE_URL e lo stato del progetto Neon.',
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

/**
 * Chiude le connessioni.
 *
 * Va passata a `ctx.waitUntil()`: la risposta all'utente non deve aspettare
 * la chiusura del pool, ma il pool non deve nemmeno restare aperto.
 */
export async function disconnectDatabase(prisma: PrismaClient): Promise<void> {
  try {
    await prisma.$disconnect();
  } catch (error) {
    // Una disconnessione fallita non ha nessuna conseguenza per l'utente:
    // l'isolate viene comunque riciclato.
    log.debug({ err: error }, 'Disconnessione del database non riuscita');
  }
}
