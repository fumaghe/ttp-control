/**
 * URL delle immagini profilo Discord.
 *
 * Un solo posto che sa come si compone un URL del CDN: nessun avatar esterno,
 * nessun link hardcodato altrove nel progetto.
 *
 * @see https://discord.com/developers/docs/reference#image-formatting
 */
import type { ApiUser, Snowflake } from './api.js';

const CDN_BASE = 'https://cdn.discordapp.com';

/**
 * Dimensione richiesta al CDN.
 *
 * L'embed mostra l'avatar come immagine grande (`setImage`), non come
 * thumbnail: 1024 e' la potenza di due che Discord accetta e che regge quel
 * formato senza sgranare.
 */
const AVATAR_SIZE = 1024;

/** Numero di avatar di default nel sistema "username unico" (discriminator 0). */
const DEFAULT_AVATAR_COUNT = 6n;

/** Numero di avatar di default nel vecchio sistema con discriminator. */
const LEGACY_DEFAULT_AVATAR_COUNT = 5;

/** Il minimo che serve per costruire l'URL: non richiede un `ApiUser` intero. */
export interface AvatarSource {
  readonly id: Snowflake;
  /** Hash dell'avatar custom. `null`/assente = avatar di default. */
  readonly avatar?: string | null | undefined;
  /** `"0"` (o assente) sugli account migrati al nuovo sistema di username. */
  readonly discriminator?: string | undefined;
}

/**
 * Indice dell'avatar di default.
 *
 * Regola corrente di Discord: per gli account migrati al nuovo sistema di
 * username (`discriminator === "0"`) l'indice deriva dai bit alti dello
 * snowflake; per gli account legacy resta `discriminator % 5`.
 */
export function defaultAvatarIndex(source: AvatarSource): number {
  const { discriminator } = source;

  if (discriminator !== undefined && discriminator !== '' && discriminator !== '0') {
    const parsed = Number.parseInt(discriminator, 10);
    if (Number.isFinite(parsed)) {
      return Math.abs(parsed) % LEGACY_DEFAULT_AVATAR_COUNT;
    }
  }

  try {
    return Number((BigInt(source.id) >> 22n) % DEFAULT_AVATAR_COUNT);
  } catch {
    // ID non numerico: non deve mai succedere con uno snowflake vero, ma un
    // avatar sbagliato e' comunque meglio di un messaggio non inviato.
    return 0;
  }
}

/** URL dell'avatar di default assegnato da Discord. */
export function defaultAvatarUrl(source: AvatarSource): string {
  return `${CDN_BASE}/embed/avatars/${defaultAvatarIndex(source)}.png`;
}

/**
 * URL dell'immagine profilo, in ordine di preferenza:
 *  1. l'avatar custom dell'utente (GIF se il l'hash inizia per `a_`);
 *  2. l'avatar di default che Discord gli assegna.
 *
 * Volutamente l'avatar UTENTE e non quello per-server: il goodbye viene
 * costruito quando il membro non e' piu' nella guild, e un avatar per-server
 * a quel punto non esiste piu'.
 */
export function avatarUrl(source: AvatarSource): string {
  const hash = source.avatar;
  if (hash === undefined || hash === null || hash === '') {
    return defaultAvatarUrl(source);
  }

  // Gli avatar animati hanno l'hash prefissato da `a_` e vanno serviti in GIF:
  // chiederli in PNG restituisce un fermo immagine.
  const extension = hash.startsWith('a_') ? 'gif' : 'png';
  return `${CDN_BASE}/avatars/${source.id}/${hash}.${extension}?size=${AVATAR_SIZE}`;
}

/** Comodita': l'avatar di un utente restituito dall'API. */
export function userAvatarUrl(user: ApiUser): string {
  return avatarUrl(user);
}
