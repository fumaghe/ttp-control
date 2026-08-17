/**
 * Payload dei messaggi Discord.
 *
 * Sostituisce `BaseMessageOptions` di discord.js. Accetta indifferentemente
 * gli oggetti gia' in forma API o i builder di `@discordjs/builders` (che
 * espongono `toJSON()`), cosi' i componenti della V1 restano invariati.
 */
import type {
  APIActionRowComponent,
  APIAllowedMentions,
  APIComponentInMessageActionRow,
  APIEmbed,
  APIModalInteractionResponseCallbackData,
} from 'discord-api-types/v10';

/** Qualcosa che sa serializzarsi nella forma attesa dall'API. */
export interface Serializable<T> {
  toJSON(): T;
}

export type EmbedInput = APIEmbed | Serializable<APIEmbed>;
export type ComponentRowInput =
  | APIActionRowComponent<APIComponentInMessageActionRow>
  | Serializable<APIActionRowComponent<APIComponentInMessageActionRow>>;
export type ModalInput =
  APIModalInteractionResponseCallbackData | Serializable<APIModalInteractionResponseCallbackData>;

/** Il contenuto di un messaggio, prima della serializzazione. */
export interface MessagePayload {
  readonly content?: string | undefined;
  readonly embeds?: readonly EmbedInput[] | undefined;
  readonly components?: readonly ComponentRowInput[] | undefined;
}

/** Il messaggio nella forma accettata dall'API Discord. */
export interface ApiMessagePayload {
  content?: string;
  embeds?: APIEmbed[];
  components?: APIActionRowComponent<APIComponentInMessageActionRow>[];
  flags?: number;
  allowed_mentions?: APIAllowedMentions;
}

function isSerializable<T>(value: T | Serializable<T>): value is Serializable<T> {
  return typeof (value as Serializable<T>).toJSON === 'function';
}

function serialize<T>(value: T | Serializable<T>): T {
  return isSerializable(value) ? value.toJSON() : value;
}

/**
 * Nessuna menzione deve pingare: gli embed di audit contengono `<@id>` per
 * essere leggibili, non per svegliare mezzo server. Era il comportamento
 * configurato sul client discord.js della V1 e va preservato.
 */
export const SILENT_MENTIONS: APIAllowedMentions = { parse: [] };

/** Converte un payload applicativo nella forma API. */
export function toApiMessage(payload: MessagePayload): ApiMessagePayload {
  const output: ApiMessagePayload = { allowed_mentions: SILENT_MENTIONS };

  if (payload.content !== undefined) output.content = payload.content;
  if (payload.embeds !== undefined) output.embeds = payload.embeds.map(serialize);
  if (payload.components !== undefined) output.components = payload.components.map(serialize);

  return output;
}

/**
 * Come `toApiMessage`, ma i campi assenti diventano espliciti (`''`, `[]`).
 *
 * Serve per le PATCH: omettere `components` lascerebbe i bottoni vecchi
 * attaccati al messaggio, che nel caso della paginazione del roster
 * significa controlli che puntano alla pagina sbagliata.
 */
export function toApiMessageForEdit(payload: MessagePayload): ApiMessagePayload {
  return {
    content: payload.content ?? '',
    embeds: (payload.embeds ?? []).map(serialize),
    components: (payload.components ?? []).map(serialize),
    allowed_mentions: SILENT_MENTIONS,
  };
}

export function toApiModal(modal: ModalInput): APIModalInteractionResponseCallbackData {
  return serialize(modal);
}
