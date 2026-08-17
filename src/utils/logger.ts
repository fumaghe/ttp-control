/**
 * Logger applicativo, indipendente dalla runtime.
 *
 * V1 usava pino. Pino dipende da `worker_threads`, da stream Node e da
 * `process.stdout`: nulla di tutto questo esiste su Cloudflare Workers.
 * Qui c'e' un logger strutturato minimale che scrive JSON su `console`, che
 * e' l'unico canale disponibile sia su Workers (dove finisce in
 * `wrangler tail`) sia su Node.
 *
 * L'API pubblica e' identica a quella di prima (`initLogger`, `getLogger`,
 * `createLogger`, `.child()`), quindi il resto del codice non cambia.
 *
 * Garanzie invariate rispetto alla V1:
 *  - i secret non finiscono mai nei log: redazione sui campi strutturati e
 *    `scrubSecrets` sul testo libero;
 *  - in sviluppo l'output e' leggibile, altrove e' JSON su una riga.
 *
 * Il resto del codice di runtime non deve usare `console.*` (ESLint lo vieta).
 */
/* eslint-disable no-console */
import { scrubSecrets } from './redact.js';

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
export type LogLevelName = (typeof LEVELS)[number];

const LEVEL_VALUE: Readonly<Record<LogLevelName, number>> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

/** Chiavi il cui valore viene sempre oscurato nei log strutturati. */
const REDACTED_KEYS: ReadonlySet<string> = new Set([
  'token',
  'discordToken',
  'discordPublicKey',
  'publicKey',
  'password',
  'databaseUrl',
  'directUrl',
  'connectionString',
  'authorization',
  'DATABASE_URL',
  'DIRECT_URL',
  'DISCORD_TOKEN',
  'DISCORD_PUBLIC_KEY',
]);

const REDACTED = '[redacted]';

/** Profondita' massima nella normalizzazione: evita cicli e oggetti enormi. */
const MAX_DEPTH = 4;

/** Rappresentazione testuale sicura di un valore di tipo ignoto. */
function describe(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'function') return '[function]';
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint' ||
    typeof value === 'symbol'
  ) {
    return String(value);
  }
  // Restano solo gli oggetti: `String()` darebbe "[object Object]", che non
  // dice nulla. Il JSON almeno mostra il contenuto.
  try {
    return JSON.stringify(value);
  } catch {
    return '[non serializzabile]';
  }
}

function normalizeError(error: Error): Record<string, unknown> {
  return {
    type: error.name,
    message: scrubSecrets(error.message),
    ...(error.stack === undefined ? {} : { stack: scrubSecrets(error.stack) }),
    ...(error.cause === undefined ? {} : { cause: describe(error.cause).slice(0, 200) }),
  };
}

/**
 * Prepara un valore per la serializzazione JSON: oscura le chiavi sensibili,
 * neutralizza i secret nel testo libero e rende serializzabili gli errori.
 */
function normalize(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return scrubSecrets(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) return normalizeError(value);
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_DEPTH) return '[deep]';
  if (value instanceof Set) return normalize([...value], depth + 1);
  if (value instanceof Map) return normalize(Object.fromEntries(value), depth + 1);
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => normalize(item, depth + 1));

  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = REDACTED_KEYS.has(key) ? REDACTED : normalize(item, depth + 1);
    }
    return output;
  }

  // Funzioni, symbol e simili non hanno posto in un log strutturato.
  return describe(value);
}

export interface AppLogger {
  trace(payload: unknown, message?: string): void;
  debug(payload: unknown, message?: string): void;
  info(payload: unknown, message?: string): void;
  warn(payload: unknown, message?: string): void;
  error(payload: unknown, message?: string): void;
  fatal(payload: unknown, message?: string): void;
  child(bindings: Record<string, unknown>): AppLogger;
  readonly level: LogLevelName;
}

interface LoggerState {
  level: LogLevelName;
  pretty: boolean;
}

const state: LoggerState = { level: 'info', pretty: false };

function isLevelName(value: string): value is LogLevelName {
  return (LEVELS as readonly string[]).includes(value);
}

function emit(
  level: LogLevelName,
  bindings: Record<string, unknown>,
  payload: unknown,
  message: string | undefined,
): void {
  if (LEVEL_VALUE[level] < LEVEL_VALUE[state.level]) return;

  // Firma pino-like: `log.info(obj, msg)` oppure `log.info(msg)`.
  const [fields, text] =
    typeof payload === 'string' ? [{}, payload] : [payload ?? {}, message ?? ''];

  const record: Record<string, unknown> = {
    level,
    time: new Date().toISOString(),
    ...bindings,
    ...(normalize(fields) as Record<string, unknown>),
  };
  if (text !== '') record['msg'] = scrubSecrets(text);

  const line = state.pretty
    ? `${level.toUpperCase().padEnd(5)} ${describe(record['module'] ?? '-')} ${describe(record['msg'] ?? '')} ${JSON.stringify(record)}`
    : JSON.stringify(record);

  switch (level) {
    case 'trace':
    case 'debug':
      console.debug(line);
      break;
    case 'info':
      console.info(line);
      break;
    case 'warn':
      console.warn(line);
      break;
    case 'error':
    case 'fatal':
      console.error(line);
      break;
    default: {
      const exhaustive: never = level;
      throw new Error(`Livello di log sconosciuto: ${String(exhaustive)}`);
    }
  }
}

function build(bindings: Record<string, unknown>): AppLogger {
  return {
    get level(): LogLevelName {
      return state.level;
    },
    trace: (payload, message) => {
      emit('trace', bindings, payload, message);
    },
    debug: (payload, message) => {
      emit('debug', bindings, payload, message);
    },
    info: (payload, message) => {
      emit('info', bindings, payload, message);
    },
    warn: (payload, message) => {
      emit('warn', bindings, payload, message);
    },
    error: (payload, message) => {
      emit('error', bindings, payload, message);
    },
    fatal: (payload, message) => {
      emit('fatal', bindings, payload, message);
    },
    child: (extra) => build({ ...bindings, ...extra }),
  };
}

const root = build({});

/**
 * Configura il logger radice. Va chiamato una volta, appena l'environment e'
 * stato validato. Su Workers viene richiamato a ogni richiesta: e'
 * idempotente e non alloca nulla.
 */
export function initLogger(options: { level: string; pretty?: boolean }): AppLogger {
  state.level = isLevelName(options.level) ? options.level : 'info';
  state.pretty = options.pretty ?? false;
  return root;
}

/** Logger radice. */
export function getLogger(): AppLogger {
  return root;
}

/** Logger figlio etichettato per modulo. */
export function createLogger(module: string): AppLogger {
  return build({ module });
}
