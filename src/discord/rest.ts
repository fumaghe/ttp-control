/**
 * Client HTTP per l'API Discord.
 *
 * E' l'UNICO punto del progetto che chiama `fetch()` verso Discord: nessuna
 * chiamata sparsa altrove, cosi' autenticazione, rate limit, timeout e
 * redazione dei secret vivono in un posto solo (requisito esplicito
 * dell'architettura: Service → Gateway → REST → Discord).
 *
 * Sostituisce il `REST` di discord.js, che non e' utilizzabile sulla runtime
 * dei Worker.
 */
import { AppError, ERROR_CODE } from '../errors/AppError.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('discord-rest');

const API_BASE = 'https://discord.com/api/v10';

/** Oltre questo tempo una singola richiesta viene abbandonata. */
const REQUEST_TIMEOUT_MS = 8_000;

/** Tentativi massimi su 429 / 5xx. Oltre, l'errore si propaga. */
const MAX_ATTEMPTS = 3;

/** Un retry non aspetta mai piu' di cosi': meglio fallire che far scadere l'interaction. */
const MAX_RETRY_DELAY_MS = 5_000;

export interface DiscordRequestOptions {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | undefined>> | undefined;
  readonly body?: unknown;
  /** Finisce nell'audit log di Discord (`X-Audit-Log-Reason`). */
  readonly reason?: string | undefined;
  /**
   * Autenticazione con il bot token. `false` per gli endpoint webhook delle
   * interaction, che sono autenticati dal token dell'interaction stessa.
   */
  readonly auth?: boolean;
}

/** Errore restituito dall'API Discord, con il codice JSON quando presente. */
export class DiscordApiError extends Error {
  public readonly status: number;

  /** Codice JSON Discord (es. 10007 Unknown Member), se fornito. */
  public readonly code: number | undefined;

  public readonly method: string;

  public readonly path: string;

  public constructor(input: {
    status: number;
    code?: number | undefined;
    message: string;
    method: string;
    path: string;
  }) {
    super(`Discord ${input.method} ${input.path} → ${input.status}: ${input.message}`);
    this.name = 'DiscordApiError';
    this.status = input.status;
    this.code = input.code;
    this.method = input.method;
    this.path = input.path;
  }
}

export function isDiscordApiError(error: unknown): error is DiscordApiError {
  return error instanceof DiscordApiError;
}

/** L'errore indica che la risorsa non esiste (piu'). */
export function isNotFound(error: unknown, ...codes: readonly number[]): boolean {
  if (!isDiscordApiError(error)) return false;
  if (error.status === 404) return true;
  return error.code !== undefined && codes.includes(error.code);
}

export interface DiscordRest {
  request<T>(options: DiscordRequestOptions): Promise<T>;
  get<T>(path: string, query?: DiscordRequestOptions['query']): Promise<T>;
  post<T>(path: string, body: unknown, reason?: string): Promise<T>;
  patch<T>(path: string, body: unknown, reason?: string): Promise<T>;
  put<T>(path: string, body: unknown, reason?: string): Promise<T>;
  delete<T>(path: string, reason?: string): Promise<T>;
  /** Chiamate agli endpoint webhook dell'interaction: nessun bot token. */
  unauthenticated<T>(options: Omit<DiscordRequestOptions, 'auth'>): Promise<T>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

interface ErrorBody {
  message?: unknown;
  code?: unknown;
  retry_after?: unknown;
}

async function readErrorBody(response: Response): Promise<ErrorBody> {
  try {
    const parsed = (await response.json()) as ErrorBody | null;
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function buildUrl(path: string, query: DiscordRequestOptions['query']): string {
  const url = new URL(`${API_BASE}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

export interface DiscordRestOptions {
  readonly token: string;
  /** Iniettabile nei test: di default `globalThis.fetch`. */
  readonly fetchImpl?: typeof fetch;
  readonly userAgent?: string;
}

export function createDiscordRest(options: DiscordRestOptions): DiscordRest {
  const doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const userAgent =
    options.userAgent ?? 'DiscordBot (https://github.com/fumaghe/ttp-control, 2.0.0)';

  async function request<T>(input: DiscordRequestOptions): Promise<T> {
    const url = buildUrl(input.path, input.query);
    const useAuth = input.auth ?? true;

    const headers: Record<string, string> = {
      'User-Agent': userAgent,
      Accept: 'application/json',
    };
    if (useAuth) headers['Authorization'] = `Bot ${options.token}`;
    if (input.body !== undefined) headers['Content-Type'] = 'application/json';
    if (input.reason !== undefined && input.reason !== '') {
      // L'header ammette solo caratteri validi in un header HTTP.
      headers['X-Audit-Log-Reason'] = encodeURIComponent(input.reason.slice(0, 400));
    }

    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      let response: Response;
      try {
        response = await doFetch(url, {
          method: input.method,
          headers,
          ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        // Errore di rete o timeout: vale la pena riprovare, ma non all'infinito.
        lastError = error;
        if (attempt === MAX_ATTEMPTS) break;
        await sleep(Math.min(250 * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS));
        continue;
      }

      if (response.status === 204) return undefined as T;

      if (response.ok) {
        const text = await response.text();
        if (text === '') return undefined as T;
        return JSON.parse(text) as T;
      }

      const body = await readErrorBody(response);

      // --- Rate limit ----------------------------------------------------
      if (response.status === 429) {
        const retryAfterHeader = response.headers.get('retry-after');
        const retryAfterSeconds =
          typeof body.retry_after === 'number'
            ? body.retry_after
            : Number.parseFloat(retryAfterHeader ?? '1');
        const delay = Math.min(
          Math.max(Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : 1000, 100),
          MAX_RETRY_DELAY_MS,
        );

        log.warn(
          {
            path: input.path,
            method: input.method,
            delayMs: delay,
            global: response.headers.get('x-ratelimit-global') === 'true',
            attempt,
          },
          'Rate limit Discord: attesa prima del retry',
        );

        if (attempt === MAX_ATTEMPTS) {
          throw new DiscordApiError({
            status: 429,
            message: 'rate limit non rientrato entro i tentativi disponibili',
            method: input.method,
            path: input.path,
          });
        }
        await sleep(delay);
        continue;
      }

      // --- 5xx: transitorio ------------------------------------------------
      if (response.status >= 500 && attempt < MAX_ATTEMPTS) {
        await sleep(Math.min(250 * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS));
        continue;
      }

      throw new DiscordApiError({
        status: response.status,
        code: typeof body.code === 'number' ? body.code : undefined,
        message: typeof body.message === 'string' ? body.message : response.statusText,
        method: input.method,
        path: input.path,
      });
    }

    log.error(
      { err: lastError, path: input.path, method: input.method },
      'Discord non raggiungibile',
    );
    throw new AppError(ERROR_CODE.DISCORD_ERROR, 'Discord non è raggiungibile in questo momento.', {
      cause: lastError,
      context: { path: input.path, method: input.method },
    });
  }

  return {
    request,
    get: (path, query) => request({ method: 'GET', path, query }),
    post: (path, body, reason) => request({ method: 'POST', path, body, reason }),
    patch: (path, body, reason) => request({ method: 'PATCH', path, body, reason }),
    put: (path, body, reason) => request({ method: 'PUT', path, body, reason }),
    delete: (path, reason) => request({ method: 'DELETE', path, reason }),
    unauthenticated: (input) => request({ ...input, auth: false }),
  };
}
