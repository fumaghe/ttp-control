/**
 * Selezione casuale, senza dipendenze esterne.
 *
 * `Math.random()` basta: qui la casualita' serve a non ripetere sempre la
 * stessa frase in un messaggio di benvenuto, non a generare un token. Non e'
 * randomness di sicurezza e non deve esserlo.
 */

/**
 * Un elemento a caso, con distribuzione uniforme.
 *
 * @throws Error se l'array e' vuoto: un array di frasi vuoto e' un errore di
 * configurazione, non un caso da gestire con `undefined` a valle.
 */
export function pickRandom<T>(items: readonly T[]): T {
  if (items.length === 0) {
    throw new Error('pickRandom: array vuoto');
  }
  const index = Math.floor(Math.random() * items.length);
  // `Math.random()` restituisce [0, 1): l'indice e' sempre in range, ma il
  // clamp protegge da implementazioni che restituiscono esattamente 1.
  return items[Math.min(index, items.length - 1)] as T;
}
