/**
 * Endpoint HTTP del Worker.
 *
 * Copre il contratto che Discord si aspetta all'Interactions Endpoint URL:
 * PING/PONG di validazione, rifiuto delle richieste non firmate, e i metodi
 * non ammessi. È il perimetro esterno del bot: qui non si sbaglia.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import worker, { type WorkerExecutionContext } from '../../src/worker/index.js';
import { pingInteraction } from '../support/discordFixtures.js';

/** `CryptoKeyPair` non è dichiarato allo stesso modo su Node e su Workers. */
interface GeneratedKeyPair {
  readonly publicKey: CryptoKey;
  readonly privateKey: CryptoKey;
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

let publicKeyHex: string;
let privateKey: CryptoKey;

// Una sola coppia per l'intero file: il Worker valida l'environment una
// volta per isolate, esattamente come in produzione, dove i binding non
// cambiano sotto i piedi.
beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as unknown as GeneratedKeyPair;
  privateKey = pair.privateKey;
  publicKeyHex = toHex(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
});

/** Bindings completi e validi: gli stessi che Cloudflare passa al Worker. */
function bindings(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    DISCORD_TOKEN: ['MTIzNDU2Nzg5MDEyMzQ1Njc4', 'GaBcDe', 'x'.repeat(30)].join('.'),
    DISCORD_PUBLIC_KEY: publicKeyHex,
    CLIENT_ID: '100000000000000003',
    GUILD_ID: '100000000000000001',
    OWNER_ID: '100000000000000002',
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/test',
    ROLE_VERIFIED_ID: '200000000000000001',
    ROLE_TTP_ID: '200000000000000002',
    ROLE_OG_ID: '200000000000000003',
    ROLE_BIG_HOMIE_ID: '200000000000000004',
    ROLE_BIG_ID: '200000000000000019',
    ROLE_ORIGINAL_TINY_LOC_ID: '200000000000000005',
    ROLE_LOC_ID: '200000000000000020',
    ROLE_TINY_LOC_ID: '200000000000000006',
    ROLE_INFANTIL_LOC_ID: '200000000000000021',
    ROLE_GANG_BANGER_ID: '200000000000000022',
    ROLE_RESIDENT_ID: '200000000000000007',
    ROLE_FRIEND_ID: '200000000000000008',
    ROLE_MAFIA_ID: '200000000000000009',
    ROLE_BANNED_ID: '200000000000000010',
    ROLE_INACTIVE_ID: '200000000000000011',
    ROLE_PERMADEATH_ID: '200000000000000012',
    ROLE_HONOR_1_ID: '200000000000000013',
    ROLE_HONOR_2_ID: '200000000000000014',
    ROLE_SUPPORTER_ID: '200000000000000015',
    ROLE_FIRST_DAY_ID: '200000000000000016',
    ROLE_SHOOTER_ID: '200000000000000017',
    ROLE_MAIN_SHOOTER_ID: '200000000000000018',
    CHANNEL_VERIFY_ID: '300000000000000001',
    CHANNEL_VERIFY_REQUESTS_ID: '300000000000000002',
    CHANNEL_MEMBER_MANAGEMENT_ID: '300000000000000003',
    CHANNEL_MEMBER_LOGS_ID: '300000000000000004',
    CHANNEL_AUDIT_LOG_ID: '300000000000000005',
    CHANNEL_BLACKLIST_ID: '300000000000000006',
    CHANNEL_CONTROL_PANEL_ID: '300000000000000007',
    CHANNEL_WELCOME_ID: '300000000000000008',
    CHANNEL_GOODBYE_ID: '300000000000000009',
    CHANNEL_PUT_ON_OFF_ID: '300000000000000010',
    ...overrides,
  };
}

const pending: Promise<unknown>[] = [];

/** Contesto d'esecuzione minimo: raccoglie i task differiti dal Worker. */
const executionContext: WorkerExecutionContext = {
  waitUntil(promise: Promise<unknown>): void {
    pending.push(promise);
  },
};

async function signedRequest(
  body: string,
  options: { path?: string; timestamp?: string; signature?: string } = {},
): Promise<Request> {
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000));
  const signature =
    options.signature ??
    toHex(
      new Uint8Array(
        await crypto.subtle.sign('Ed25519', privateKey, new TextEncoder().encode(timestamp + body)),
      ),
    );

  return new Request(`https://ttp-control.workers.dev${options.path ?? '/interactions'}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-signature-ed25519': signature,
      'x-signature-timestamp': timestamp,
    },
    body,
  });
}

describe('PING di validazione', () => {
  it('risponde PONG a una PING firmata', async () => {
    // È esattamente ciò che Discord invia quando si salva l'Interactions
    // Endpoint URL nel Developer Portal.
    const body = JSON.stringify(pingInteraction());
    const response = await worker.fetch(await signedRequest(body), bindings(), executionContext);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ type: 1 });
  });

  it('accetta il PING anche sulla root', async () => {
    const body = JSON.stringify(pingInteraction());
    const response = await worker.fetch(
      await signedRequest(body, { path: '/' }),
      bindings(),
      executionContext,
    );

    expect(await response.json()).toEqual({ type: 1 });
  });
});

describe('richieste non autenticate', () => {
  it('rifiuta con 401 una richiesta senza firma', async () => {
    const request = new Request('https://ttp-control.workers.dev/interactions', {
      method: 'POST',
      body: JSON.stringify(pingInteraction()),
    });

    const response = await worker.fetch(request, bindings(), executionContext);
    expect(response.status).toBe(401);
  });

  it('rifiuta con 401 una firma non valida', async () => {
    const body = JSON.stringify(pingInteraction());
    const request = await signedRequest(body, { signature: 'ab'.repeat(64) });

    const response = await worker.fetch(request, bindings(), executionContext);
    expect(response.status).toBe(401);
  });

  it('rifiuta con 401 un corpo manomesso dopo la firma', async () => {
    const original = JSON.stringify(pingInteraction());
    const request = await signedRequest(original);

    // Stessa firma, corpo diverso: è il caso che la verifica esiste per
    // fermare.
    const tampered = new Request(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify({ type: 2, data: { name: 'member' } }),
    });

    const response = await worker.fetch(tampered, bindings(), executionContext);
    expect(response.status).toBe(401);
  });

  it('rifiuta con 401 un timestamp fuori tolleranza (replay)', async () => {
    const body = JSON.stringify(pingInteraction());
    const stale = String(Math.floor(Date.now() / 1000) - 3600);
    const request = await signedRequest(body, { timestamp: stale });

    const response = await worker.fetch(request, bindings(), executionContext);
    expect(response.status).toBe(401);
  });

  it('non rivela il motivo del rifiuto', async () => {
    // Distinguere "firma sbagliata" da "timestamp scaduto" direbbe a chi
    // sonda l'endpoint quanto si è avvicinato.
    const body = JSON.stringify(pingInteraction());
    const badSignature = await worker.fetch(
      await signedRequest(body, { signature: 'ab'.repeat(64) }),
      bindings(),
      executionContext,
    );
    const stale = await worker.fetch(
      await signedRequest(body, { timestamp: '1' }),
      bindings(),
      executionContext,
    );

    expect(await badSignature.text()).toBe(await stale.text());
  });
});

describe('metodi e percorsi', () => {
  it('espone un health check in GET', async () => {
    const response = await worker.fetch(
      new Request('https://ttp-control.workers.dev/interactions'),
      bindings(),
      executionContext,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('interactions endpoint attivo');
  });

  it('rifiuta i metodi non ammessi', async () => {
    const response = await worker.fetch(
      new Request('https://ttp-control.workers.dev/interactions', { method: 'DELETE' }),
      bindings(),
      executionContext,
    );

    expect(response.status).toBe(405);
  });

  it('risponde 404 su un percorso sconosciuto', async () => {
    const body = JSON.stringify(pingInteraction());
    const response = await worker.fetch(
      await signedRequest(body, { path: '/altro' }),
      bindings(),
      executionContext,
    );

    expect(response.status).toBe(404);
  });
});
