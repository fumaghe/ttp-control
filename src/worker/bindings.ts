/**
 * Binding del Worker.
 *
 * Cloudflare passa a `fetch()` e `scheduled()` un oggetto con:
 *  - le `vars` di `wrangler.jsonc` (ID Discord, non sensibili);
 *  - i secret caricati con `wrangler secret put` (token, chiave pubblica,
 *    eventuale connection string);
 *  - i binding veri e propri, come Hyperdrive.
 *
 * Le prime due categorie sono stringhe e alimentano la stessa validazione
 * dell'environment usata dagli script Node: una sola definizione di che cosa
 * il bot considera "configurato".
 */
import type { EnvSource } from '../config/env.js';

/** Binding Hyperdrive: espone la connection string da usare col driver pg. */
export interface HyperdriveBinding {
  readonly connectionString: string;
}

export interface WorkerBindings extends Record<string, unknown> {
  /** Pool Hyperdrive verso Neon. Assente in sviluppo locale senza binding. */
  readonly HYPERDRIVE?: HyperdriveBinding | undefined;
}

/**
 * Connection string da usare a runtime.
 *
 * Ordine deliberato:
 *  1. Hyperdrive, se il binding c'è — è il percorso raccomandato su Workers:
 *     tiene il pool di connessioni lato Cloudflare, così il Worker non apre
 *     una connessione TCP nuova a ogni invocazione;
 *  2. `DATABASE_URL`, per `wrangler dev` senza Hyperdrive e come via d'uscita
 *     se Hyperdrive non è disponibile.
 *
 * In entrambi i casi si parla con lo STESSO database Neon: Hyperdrive è un
 * pooler davanti, non un altro database.
 */
export function resolveDatabaseUrl(bindings: WorkerBindings, fallback: string): string {
  const hyperdrive = bindings.HYPERDRIVE;
  if (hyperdrive && typeof hyperdrive.connectionString === 'string') {
    return hyperdrive.connectionString;
  }
  return fallback;
}

/** `true` se il traffico verso il database passa da Hyperdrive. */
export function usesHyperdrive(bindings: WorkerBindings): boolean {
  return typeof bindings.HYPERDRIVE?.connectionString === 'string';
}

/**
 * Estrae le sole variabili stringa dai binding: è ciò che la validazione
 * dell'environment sa leggere. I binding oggetto (Hyperdrive, KV, …) non
 * sono variabili d'ambiente e vengono ignorati.
 */
export function toEnvSource(bindings: WorkerBindings): EnvSource {
  const source: Record<string, string> = {};
  for (const [key, value] of Object.entries(bindings)) {
    if (typeof value === 'string') source[key] = value;
  }
  return source;
}
