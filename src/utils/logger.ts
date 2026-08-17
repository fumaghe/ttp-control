/**
 * Logger applicativo (pino).
 *
 * Garanzie:
 *  - i secret non finiscono mai nei log: sia via `redact` di pino sui campi
 *    strutturati, sia via `scrubSecrets` sul testo libero dei messaggi;
 *  - in sviluppo l'output e' leggibile, in produzione e' JSON su stdout.
 *
 * Il resto del codice di runtime non deve usare `console.*` (ESLint lo vieta).
 */
import { pino, type Logger, type LoggerOptions } from 'pino';
import { scrubSecrets } from './redact.js';

/** Chiavi il cui valore viene sempre oscurato nei log strutturati. */
const REDACT_PATHS = [
  'token',
  'discordToken',
  'password',
  'databaseUrl',
  'directUrl',
  'DATABASE_URL',
  'DIRECT_URL',
  'DISCORD_TOKEN',
  '*.token',
  '*.password',
  '*.databaseUrl',
  '*.directUrl',
  'env.discordToken',
  'env.databaseUrl',
  'env.directUrl',
];

export type AppLogger = Logger;

function baseOptions(level: string, pretty: boolean): LoggerOptions {
  return {
    level,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    // Ultima rete: neutralizza i secret anche nel testo libero, che pino
    // `redact` non tocca (i messaggi d'errore dei driver li contengono).
    hooks: {
      logMethod(args, method) {
        const scrubbed = args.map((arg) => (typeof arg === 'string' ? scrubSecrets(arg) : arg));
        method.apply(this, scrubbed as Parameters<typeof method>);
      },
    },
    formatters: {
      level: (label) => ({ level: label }),
    },
    ...(pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
          },
        }
      : {}),
  };
}

let root: AppLogger | undefined;

/**
 * Inizializza il logger radice. Va chiamato una volta sola, allo startup,
 * appena l'environment e' stato validato.
 */
export function initLogger(options: { level: string; pretty: boolean }): AppLogger {
  root = pino(baseOptions(options.level, options.pretty));
  return root;
}

/**
 * Logger radice. Se `initLogger` non e' ancora stato chiamato ne crea uno
 * minimale: serve a non perdere i log degli errori di bootstrap.
 */
export function getLogger(): AppLogger {
  root ??= pino(baseOptions(process.env['LOG_LEVEL'] ?? 'info', false));
  return root;
}

/** Logger figlio etichettato per modulo: `logger.child({ module })`. */
export function createLogger(module: string): AppLogger {
  return getLogger().child({ module });
}
