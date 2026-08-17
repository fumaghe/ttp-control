/**
 * Sanitizzazione dei valori sensibili prima che finiscano nei log.
 *
 * Nessuna connection string completa, nessun token, nessuna password deve
 * mai comparire in output — nemmeno dentro il messaggio di un'eccezione
 * lanciata da una libreria di terze parti.
 */

export const REDACTED = '[redacted]';

/**
 * Riduce una connection string PostgreSQL a `host/database`, scartando
 * utente, password e query string.
 *
 * @example
 *   sanitizeDatabaseUrl('postgresql://u:pw@ep-x-pooler.aws.neon.tech/main?sslmode=require')
 *   // 'ep-x-pooler.aws.neon.tech/main'
 */
export function sanitizeDatabaseUrl(url: string | undefined): string {
  if (!url) return '<non configurato>';
  try {
    const parsed = new URL(url);
    const database = parsed.pathname.replace(/^\//, '');
    return database ? `${parsed.host}/${database}` : parsed.host;
  } catch {
    // Se non e' parsabile non rischiamo di stampare frammenti con la password.
    return REDACTED;
  }
}

/** Mostra solo la coda di un token, quel tanto che basta per distinguerlo. */
export function maskToken(token: string | undefined): string {
  if (!token) return '<non configurato>';
  if (token.length <= 8) return REDACTED;
  return `${REDACTED}…${token.slice(-4)}`;
}

/* --- Pattern di secret da neutralizzare nel testo libero --------------- */

/** Connection string con credenziali: `postgres://user:password@host`. */
const CONNECTION_STRING_PATTERN = /\b(postgres(?:ql)?:\/\/)[^\s@/]+:[^\s@/]+@/gi;

/** Bot token Discord: tre segmenti base64url separati da punto. */
const DISCORD_TOKEN_PATTERN = /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{25,}\b/g;

/** Coppie chiave/valore esplicite: `password=…`, `token: …`. */
const KEY_VALUE_PATTERN = /\b(password|passwd|pwd|token|secret|api[_-]?key)\s*[=:]\s*\S+/gi;

/**
 * Rimuove dai testi liberi tutto cio' che somiglia a un secret.
 *
 * E' l'ultima rete di sicurezza: i messaggi d'errore di driver e librerie
 * possono includere la connection string per intero.
 */
export function scrubSecrets(text: string): string {
  return text
    .replace(CONNECTION_STRING_PATTERN, `$1${REDACTED}:${REDACTED}@`)
    .replace(DISCORD_TOKEN_PATTERN, REDACTED)
    .replace(KEY_VALUE_PATTERN, (_match, key: string) => `${key}=${REDACTED}`);
}
