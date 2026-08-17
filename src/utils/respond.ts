/**
 * Risposte alle interaction, senza mai incorrere in
 * `InteractionAlreadyReplied`.
 *
 * Discord accetta una sola risposta iniziale e concede 3 secondi per darla.
 * Ogni handler puo' trovarsi in uno di tre stati (non risposto / deferred /
 * gia' risposto): questi helper scelgono da soli il metodo corretto.
 *
 * Le risposte amministrative sono ephemeral per default: note della
 * Leadership, dettagli di blacklist e motivazioni non devono finire in un
 * canale pubblico.
 */
import { type InteractionReplyOptions, MessageFlags, type RepliableInteraction } from 'discord.js';
import { createLogger } from './logger.js';

const log = createLogger('respond');

/**
 * I tipi di embed e componenti accettati sono presi direttamente da
 * discord.js: così builder, oggetti API e forme intermedie passano tutti,
 * senza cast di comodo negli handler.
 */
export type ReplyEmbeds = NonNullable<InteractionReplyOptions['embeds']>;
export type ReplyComponents = NonNullable<InteractionReplyOptions['components']>;

export interface RespondOptions {
  readonly embeds?: ReplyEmbeds;
  readonly content?: string;
  readonly components?: ReplyComponents;
  /** Default `true`: le operazioni amministrative restano private. */
  readonly ephemeral?: boolean;
}

function toReplyOptions(options: RespondOptions): InteractionReplyOptions {
  const ephemeral = options.ephemeral ?? true;
  return {
    ...(options.content === undefined ? {} : { content: options.content }),
    ...(options.embeds === undefined ? {} : { embeds: [...options.embeds] }),
    ...(options.components === undefined ? {} : { components: [...options.components] }),
    // `MessageFlags.Ephemeral` e' l'API corrente: l'opzione booleana
    // `ephemeral` di discord.js e' deprecata.
    ...(ephemeral ? { flags: MessageFlags.Ephemeral } : {}),
  };
}

/**
 * Prende in carico l'interaction entro i 3 secondi concessi da Discord.
 * Idempotente: chiamarla due volte non e' un errore.
 */
export async function defer(
  interaction: RepliableInteraction,
  options: { ephemeral?: boolean } = {},
): Promise<void> {
  if (interaction.deferred || interaction.replied) return;
  await interaction.deferReply(
    (options.ephemeral ?? true) ? { flags: MessageFlags.Ephemeral } : {},
  );
}

/**
 * Risponde scegliendo automaticamente fra `reply`, `editReply` e `followUp`
 * in base allo stato dell'interaction.
 */
export async function respond(
  interaction: RepliableInteraction,
  options: RespondOptions,
): Promise<void> {
  const payload = toReplyOptions(options);

  try {
    if (interaction.deferred) {
      await interaction.editReply({
        content: payload.content ?? null,
        embeds: payload.embeds ?? [],
        components: payload.components ?? [],
      });
      return;
    }
    if (interaction.replied) {
      await interaction.followUp(payload);
      return;
    }
    await interaction.reply(payload);
  } catch (error) {
    // Un fallimento nel rispondere non deve propagarsi: l'operazione di
    // dominio potrebbe essere andata a buon fine.
    log.error(
      { err: error, interactionId: interaction.id, type: interaction.type },
      'Risposta all’interaction non riuscita',
    );
  }
}

/** Aggiorna il messaggio che contiene il componente cliccato. */
export async function updateMessage(
  interaction: { update: (payload: InteractionReplyOptions) => Promise<unknown> },
  options: { embeds?: ReplyEmbeds; components?: ReplyComponents; content?: string },
): Promise<void> {
  await interaction.update({
    ...(options.content === undefined ? {} : { content: options.content }),
    embeds: options.embeds ? [...options.embeds] : [],
    components: options.components ? [...options.components] : [],
  });
}
