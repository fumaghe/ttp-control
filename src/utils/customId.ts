/**
 * Codifica e decodifica dei `customId` di bottoni, modal e select.
 *
 * Formato: `namespace:action[:arg]*`
 *
 * Un `customId` arriva dal client e non e' affidabile: puo' essere costruito
 * a mano da chiunque possa cliccare. Va quindi SEMPRE decodificato con
 * validazione, e gli argomenti (tipicamente ID) rivalidati. Che un pannello
 * sia stato pubblicato da un OG non autorizza chi ci clicca sopra.
 */
import { ValidationError } from '../errors/AppError.js';

/** Limite Discord per la lunghezza di un `custom_id`. */
const MAX_CUSTOM_ID_LENGTH = 100;

const SEPARATOR = ':';

/** I namespace ammessi: qualunque altro viene rifiutato. */
export const NAMESPACES = [
  'verify',
  'apply',
  'application',
  'member',
  'community',
  'blacklist',
  'panel',
  'roster',
  'confirm',
] as const;

export type Namespace = (typeof NAMESPACES)[number];

export interface ParsedCustomId {
  readonly namespace: Namespace;
  readonly action: string;
  readonly args: readonly string[];
}

const SEGMENT_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** @throws Error se il risultato eccede i limiti Discord. */
export function buildCustomId(
  namespace: Namespace,
  action: string,
  ...args: readonly string[]
): string {
  const segments = [namespace, action, ...args];

  for (const segment of segments) {
    if (!SEGMENT_PATTERN.test(segment)) {
      throw new Error(`Segmento di customId non valido: "${segment}"`);
    }
  }

  const id = segments.join(SEPARATOR);
  if (id.length > MAX_CUSTOM_ID_LENGTH) {
    throw new Error(`customId troppo lungo (${id.length} > ${MAX_CUSTOM_ID_LENGTH}): ${id}`);
  }
  return id;
}

/**
 * Decodifica un `customId` validandone la forma.
 * @returns `null` se non appartiene a questo bot o e' malformato.
 */
export function parseCustomId(raw: string): ParsedCustomId | null {
  if (raw.length > MAX_CUSTOM_ID_LENGTH) return null;

  const segments = raw.split(SEPARATOR);
  if (segments.length < 2) return null;

  const [namespace, action, ...args] = segments;
  if (namespace === undefined || action === undefined) return null;
  if (!(NAMESPACES as readonly string[]).includes(namespace)) return null;
  if (!SEGMENT_PATTERN.test(action)) return null;
  if (!args.every((arg) => SEGMENT_PATTERN.test(arg))) return null;

  return { namespace: namespace as Namespace, action, args };
}

/** Come `parseCustomId`, ma lancia: da usare dentro un handler gia' scelto. */
export function requireCustomId(raw: string): ParsedCustomId {
  const parsed = parseCustomId(raw);
  if (!parsed) {
    throw new ValidationError('Interazione non riconosciuta o scaduta.');
  }
  return parsed;
}

/** Argomento posizionale obbligatorio. */
export function requireArg(parsed: ParsedCustomId, index: number, label: string): string {
  const value = parsed.args[index];
  if (value === undefined) {
    throw new ValidationError(`Interazione incompleta: manca ${label}.`);
  }
  return value;
}
