/**
 * Client HTTP verso Discord.
 *
 * È l'unico punto che parla davvero con l'API: autenticazione, rate limit,
 * timeout ed errori si comportano correttamente qui o non si comportano
 * correttamente da nessuna parte.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createDiscordRest,
  type DiscordApiError,
  isDiscordApiError,
  isNotFound,
} from '../../src/discord/rest.js';
import { AppError } from '../../src/errors/AppError.js';

interface Recorded {
  url: string;
  init: RequestInit;
}

/** `fetch` finto che risponde secondo una coda di risposte. */
function fakeFetch(responses: (() => Response)[]): {
  impl: typeof fetch;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  let index = 0;

  const impl = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return Promise.resolve(next?.() ?? new Response('{}', { status: 200 }));
  }) as unknown as typeof fetch;

  return { impl, calls };
}

const ok =
  (body: unknown = {}) =>
  (): Response =>
    new Response(JSON.stringify(body), { status: 200 });

describe('autenticazione', () => {
  it('invia il bot token sulle chiamate autenticate', async () => {
    const { impl, calls } = fakeFetch([ok({ id: '1' })]);
    const rest = createDiscordRest({ token: 'segretissimo', fetchImpl: impl });

    await rest.get('/users/@me');

    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bot segretissimo');
  });

  it('NON invia il bot token agli endpoint webhook dell’interaction', async () => {
    // Quegli endpoint sono autenticati dal token dell'interaction: mandare
    // anche il bot token sarebbe un'esposizione gratuita.
    const { impl, calls } = fakeFetch([ok()]);
    const rest = createDiscordRest({ token: 'segretissimo', fetchImpl: impl });

    await rest.unauthenticated({ method: 'PATCH', path: '/webhooks/1/tok/messages/@original' });

    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
  });

  it('codifica la motivazione nell’header di audit di Discord', async () => {
    const { impl, calls } = fakeFetch([ok()]);
    const rest = createDiscordRest({ token: 'token', fetchImpl: impl });

    await rest.patch('/guilds/1/members/2', { roles: [] }, 'Promozione a Big');

    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['X-Audit-Log-Reason']).toBe(encodeURIComponent('Promozione a Big'));
  });
});

describe('rate limit', () => {
  it('rispetta Retry-After e riprova', async () => {
    vi.useFakeTimers();
    try {
      const { impl, calls } = fakeFetch([
        () =>
          new Response(JSON.stringify({ retry_after: 0.2, message: 'rate limited' }), {
            status: 429,
            headers: { 'retry-after': '0.2' },
          }),
        ok({ id: 'ok' }),
      ]);

      const rest = createDiscordRest({ token: 'token', fetchImpl: impl });
      const promise = rest.get<{ id: string }>('/guilds/1');

      await vi.advanceTimersByTimeAsync(500);
      await expect(promise).resolves.toEqual({ id: 'ok' });
      expect(calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('si arrende dopo i tentativi disponibili invece di ciclare', async () => {
    vi.useFakeTimers();
    try {
      const { impl } = fakeFetch([
        () => new Response(JSON.stringify({ retry_after: 0.1 }), { status: 429 }),
      ]);

      const rest = createDiscordRest({ token: 'token', fetchImpl: impl });
      const promise = rest.get('/guilds/1').catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(10_000);
      const error = await promise;

      expect(isDiscordApiError(error)).toBe(true);
      expect((error as DiscordApiError).status).toBe(429);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('errori', () => {
  it('espone status e codice JSON di Discord', async () => {
    const { impl } = fakeFetch([
      () =>
        new Response(JSON.stringify({ code: 10007, message: 'Unknown Member' }), { status: 404 }),
    ]);
    const rest = createDiscordRest({ token: 'token', fetchImpl: impl });

    const error = await rest.get('/guilds/1/members/2').catch((e: unknown) => e);
    expect(isDiscordApiError(error)).toBe(true);
    expect((error as DiscordApiError).code).toBe(10007);
    expect(isNotFound(error, 10007)).toBe(true);
  });

  it('un 403 di permessi non viene scambiato per un 404', async () => {
    const { impl } = fakeFetch([
      () =>
        new Response(JSON.stringify({ code: 50013, message: 'Missing Permissions' }), {
          status: 403,
        }),
    ]);
    const rest = createDiscordRest({ token: 'token', fetchImpl: impl });

    const error = await rest.patch('/guilds/1/members/2', {}).catch((e: unknown) => e);
    expect(isNotFound(error, 10007)).toBe(false);
  });

  it('un guasto di rete diventa un AppError leggibile, non un errore grezzo', async () => {
    vi.useFakeTimers();
    try {
      const impl = (() => Promise.reject(new Error('ECONNRESET'))) as unknown as typeof fetch;
      const rest = createDiscordRest({ token: 'token', fetchImpl: impl });

      const promise = rest.get('/guilds/1').catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(10_000);
      const error = await promise;

      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('DISCORD_ERROR');
    } finally {
      vi.useRealTimers();
    }
  });

  it('gestisce il 204 senza corpo', async () => {
    const { impl } = fakeFetch([() => new Response(null, { status: 204 })]);
    const rest = createDiscordRest({ token: 'token', fetchImpl: impl });

    await expect(rest.delete('/guilds/1/members/2')).resolves.toBeUndefined();
  });
});
