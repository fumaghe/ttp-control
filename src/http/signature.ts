/**
 * Verifica della firma Ed25519 delle interaction Discord.
 *
 * Discord firma OGNI richiesta all'Interactions Endpoint URL. Chiunque
 * conosca l'URL può inviare un POST: senza questa verifica il bot
 * eseguirebbe comandi arbitrari inviati da estranei. Non è un controllo
 * accessorio, è l'unica autenticazione che esiste su questo endpoint.
 *
 * Implementata con Web Crypto (`crypto.subtle`), disponibile identica su
 * Cloudflare Workers e su Node ≥ 18: nessuna dipendenza nativa.
 *
 * @see https://discord.com/developers/docs/interactions/overview#setting-up-an-endpoint
 */
import { createLogger } from '../utils/logger.js';

const log = createLogger('signature');

export const SIGNATURE_HEADER = 'x-signature-ed25519';
export const TIMESTAMP_HEADER = 'x-signature-timestamp';

/**
 * Tolleranza sullo scarto fra il timestamp firmato e l'ora del Worker.
 *
 * Serve contro il replay: una richiesta valida catturata e reinviata più
 * tardi viene rifiutata. Cinque minuti coprono la deriva d'orologio senza
 * lasciare una finestra utile a un attaccante.
 */
export const MAX_TIMESTAMP_SKEW_SECONDS = 300;

export type SignatureFailure =
  | 'missing-headers'
  | 'malformed-signature'
  | 'malformed-public-key'
  | 'stale-timestamp'
  | 'invalid-signature';

export type SignatureResult =
  { readonly valid: true } | { readonly valid: false; readonly reason: SignatureFailure };

/**
 * Converte una stringa esadecimale in byte. `null` se non è esadecimale valido.
 *
 * Il buffer è un `ArrayBuffer` concreto (non `ArrayBufferLike`): è ciò che
 * `crypto.subtle` accetta come `BufferSource` sui tipi di Workers.
 */
export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  if (hex.length === 0 || hex.length % 2 !== 0) return null;
  const bytes = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    if (Number.isNaN(byte)) return null;
    bytes[index] = byte;
  }
  return bytes;
}

/** Le chiavi importate si riusano nell'isolate: l'import non è gratuito. */
const keyCache = new Map<string, Promise<CryptoKey>>();

function importPublicKey(publicKey: string, raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  let cached = keyCache.get(publicKey);
  if (!cached) {
    cached = crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, false, ['verify']);
    keyCache.set(publicKey, cached);
  }
  return cached;
}

export interface VerifyInput {
  /** Corpo GREZZO della richiesta: la firma copre i byte esatti, non il JSON riparsato. */
  readonly rawBody: string;
  readonly signature: string | null;
  readonly timestamp: string | null;
  /** Public Key dell'applicazione (Developer Portal → General Information). */
  readonly publicKey: string;
  /** Iniettabile nei test per verificare il controllo di freschezza. */
  readonly nowSeconds?: number;
}

/**
 * Verifica firma e freschezza di una richiesta Discord.
 *
 * Non lancia mai: restituisce l'esito, così il chiamante risponde 401 senza
 * dover distinguere fra "firma sbagliata" e "errore interno" — dall'esterno
 * devono essere indistinguibili.
 */
export async function verifyDiscordRequest(input: VerifyInput): Promise<SignatureResult> {
  const { rawBody, signature, timestamp, publicKey } = input;

  if (!signature || !timestamp) {
    return { valid: false, reason: 'missing-headers' };
  }

  const signatureBytes = hexToBytes(signature);
  if (signatureBytes?.length !== 64) {
    return { valid: false, reason: 'malformed-signature' };
  }

  const keyBytes = hexToBytes(publicKey);
  if (keyBytes?.length !== 32) {
    // Configurazione sbagliata, non un attacco: va segnalata, ma la risposta
    // resta un 401 come per qualsiasi altra firma non valida.
    log.error({}, 'DISCORD_PUBLIC_KEY non è una chiave Ed25519 valida (64 caratteri esadecimali)');
    return { valid: false, reason: 'malformed-public-key' };
  }

  const sent = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(sent)) {
    return { valid: false, reason: 'stale-timestamp' };
  }
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - sent) > MAX_TIMESTAMP_SKEW_SECONDS) {
    return { valid: false, reason: 'stale-timestamp' };
  }

  try {
    const key = await importPublicKey(publicKey, keyBytes);
    // Copia in un ArrayBuffer concreto: `TextEncoder.encode` è tipizzato su
    // `ArrayBufferLike`, che `crypto.subtle` non accetta come BufferSource.
    const encoded = new TextEncoder().encode(timestamp + rawBody);
    const message = new Uint8Array(new ArrayBuffer(encoded.byteLength));
    message.set(encoded);
    const verified = await crypto.subtle.verify('Ed25519', key, signatureBytes, message);
    return verified ? { valid: true } : { valid: false, reason: 'invalid-signature' };
  } catch (error) {
    log.error({ err: error }, 'Verifica della firma fallita');
    return { valid: false, reason: 'invalid-signature' };
  }
}

/** Solo per i test: azzera la cache delle chiavi importate. */
export function resetSignatureKeyCache(): void {
  keyCache.clear();
}
