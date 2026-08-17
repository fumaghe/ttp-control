/**
 * Verifica della firma Ed25519 delle interaction.
 *
 * È l'unica autenticazione dell'Interactions Endpoint: chiunque conosca
 * l'URL può inviare un POST. Se questi test passano per il motivo sbagliato,
 * il bot esegue comandi arbitrari inviati da estranei.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  hexToBytes,
  MAX_TIMESTAMP_SKEW_SECONDS,
  resetSignatureKeyCache,
  verifyDiscordRequest,
} from '../../src/http/signature.js';

/** `CryptoKeyPair` non è dichiarato allo stesso modo su Node e su Workers. */
interface GeneratedKeyPair {
  readonly publicKey: CryptoKey;
  readonly privateKey: CryptoKey;
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

interface KeyPair {
  readonly publicKeyHex: string;
  readonly privateKey: CryptoKey;
}

/** Coppia Ed25519 vera: la firma va verificata, non simulata. */
async function generateKeyPair(): Promise<KeyPair> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as unknown as GeneratedKeyPair;

  const raw = await crypto.subtle.exportKey('raw', pair.publicKey);
  return { publicKeyHex: toHex(new Uint8Array(raw)), privateKey: pair.privateKey };
}

async function sign(privateKey: CryptoKey, timestamp: string, body: string): Promise<string> {
  const message = new TextEncoder().encode(timestamp + body);
  const signature = await crypto.subtle.sign('Ed25519', privateKey, message);
  return toHex(new Uint8Array(signature));
}

let keys: KeyPair;
const NOW = 1_800_000_000;

beforeEach(async () => {
  resetSignatureKeyCache();
  keys = await generateKeyPair();
});

describe('hexToBytes', () => {
  it('decodifica una stringa esadecimale', () => {
    expect([...(hexToBytes('00ff10') ?? [])]).toEqual([0, 255, 16]);
  });

  it('rifiuta lunghezze dispari e caratteri non esadecimali', () => {
    expect(hexToBytes('abc')).toBeNull();
    expect(hexToBytes('zz')).toBeNull();
    expect(hexToBytes('')).toBeNull();
  });
});

describe('firma valida', () => {
  it('accetta una richiesta firmata correttamente', async () => {
    const body = JSON.stringify({ type: 1 });
    const timestamp = String(NOW);

    const result = await verifyDiscordRequest({
      rawBody: body,
      timestamp,
      signature: await sign(keys.privateKey, timestamp, body),
      publicKey: keys.publicKeyHex,
      nowSeconds: NOW,
    });

    expect(result.valid).toBe(true);
  });

  it('la firma copre il corpo GREZZO: un JSON riserializzato non passa', async () => {
    // Discord firma i byte esatti. Se il Worker verificasse un JSON
    // riparsato e riserializzato, un attaccante potrebbe alterare il payload
    // giocando su spaziatura e ordine delle chiavi.
    const original = '{"type":2,"data":{"name":"member"}}';
    const timestamp = String(NOW);
    const signature = await sign(keys.privateKey, timestamp, original);

    const reserialized = JSON.stringify(JSON.parse(original));
    expect(reserialized).not.toBe(original.replace('"name":"member"', '"name":"ping"'));

    const tampered = await verifyDiscordRequest({
      rawBody: original.replace('member', 'system'),
      timestamp,
      signature,
      publicKey: keys.publicKeyHex,
      nowSeconds: NOW,
    });

    expect(tampered.valid).toBe(false);
  });
});

describe('firma non valida', () => {
  it('rifiuta se mancano gli header', async () => {
    const result = await verifyDiscordRequest({
      rawBody: '{}',
      timestamp: null,
      signature: null,
      publicKey: keys.publicKeyHex,
      nowSeconds: NOW,
    });

    expect(result).toEqual({ valid: false, reason: 'missing-headers' });
  });

  it('rifiuta una firma malformata', async () => {
    const result = await verifyDiscordRequest({
      rawBody: '{}',
      timestamp: String(NOW),
      signature: 'non-esadecimale',
      publicKey: keys.publicKeyHex,
      nowSeconds: NOW,
    });

    expect(result).toEqual({ valid: false, reason: 'malformed-signature' });
  });

  it('rifiuta una firma valida ma prodotta da un’altra chiave', async () => {
    const other = await generateKeyPair();
    const body = '{"type":2}';
    const timestamp = String(NOW);

    const result = await verifyDiscordRequest({
      rawBody: body,
      timestamp,
      signature: await sign(other.privateKey, timestamp, body),
      publicKey: keys.publicKeyHex,
      nowSeconds: NOW,
    });

    expect(result).toEqual({ valid: false, reason: 'invalid-signature' });
  });

  it('rifiuta un corpo manomesso dopo la firma', async () => {
    const timestamp = String(NOW);
    const signature = await sign(keys.privateKey, timestamp, '{"type":2}');

    const result = await verifyDiscordRequest({
      rawBody: '{"type":2,"extra":true}',
      timestamp,
      signature,
      publicKey: keys.publicKeyHex,
      nowSeconds: NOW,
    });

    expect(result.valid).toBe(false);
  });

  it('rifiuta un replay con timestamp fuori tolleranza', async () => {
    // Richiesta perfettamente firmata, ma catturata e reinviata più tardi.
    const body = '{"type":2}';
    const timestamp = String(NOW);
    const signature = await sign(keys.privateKey, timestamp, body);

    const result = await verifyDiscordRequest({
      rawBody: body,
      timestamp,
      signature,
      publicKey: keys.publicKeyHex,
      nowSeconds: NOW + MAX_TIMESTAMP_SKEW_SECONDS + 1,
    });

    expect(result).toEqual({ valid: false, reason: 'stale-timestamp' });
  });

  it('accetta uno scarto entro la tolleranza', async () => {
    const body = '{"type":2}';
    const timestamp = String(NOW);
    const signature = await sign(keys.privateKey, timestamp, body);

    const result = await verifyDiscordRequest({
      rawBody: body,
      timestamp,
      signature,
      publicKey: keys.publicKeyHex,
      nowSeconds: NOW + MAX_TIMESTAMP_SKEW_SECONDS - 1,
    });

    expect(result.valid).toBe(true);
  });

  it('rifiuta se la public key configurata non è una chiave Ed25519', async () => {
    const body = '{"type":2}';
    const timestamp = String(NOW);

    const result = await verifyDiscordRequest({
      rawBody: body,
      timestamp,
      signature: await sign(keys.privateKey, timestamp, body),
      publicKey: 'chiave-sbagliata',
      nowSeconds: NOW,
    });

    expect(result).toEqual({ valid: false, reason: 'malformed-public-key' });
  });
});
