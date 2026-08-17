/**
 * Risposte alle interaction.
 *
 * Discord accetta una sola risposta iniziale e concede 3 secondi per darla.
 * Ogni handler puo' trovarsi in uno di tre stati (non risposto / deferred /
 * gia' risposto): questi helper delegano al responder, che sceglie da se' il
 * metodo corretto (risposta iniziale, PATCH del messaggio originale,
 * follow-up).
 *
 * Le risposte amministrative sono ephemeral per default: note della
 * Leadership, dettagli di blacklist e motivazioni non devono finire in un
 * canale pubblico.
 */
import type { ComponentRowInput, EmbedInput } from '../discord/payload.js';
import type { InteractionContext } from '../http/interactionContext.js';

export type ReplyEmbeds = readonly EmbedInput[];
export type ReplyComponents = readonly ComponentRowInput[];

export interface RespondOptions {
  readonly embeds?: ReplyEmbeds;
  readonly content?: string;
  readonly components?: ReplyComponents;
  /** Default `true`: le operazioni amministrative restano private. */
  readonly ephemeral?: boolean;
}

/**
 * Prende in carico l'interaction entro i 3 secondi concessi da Discord.
 * Idempotente: chiamarla due volte non e' un errore.
 */
export async function defer(
  interaction: InteractionContext,
  options: { ephemeral?: boolean } = {},
): Promise<void> {
  await interaction.responder.defer({ ephemeral: options.ephemeral ?? true });
}

/** Risponde, delegando al responder la scelta del metodo. */
export async function respond(
  interaction: InteractionContext,
  options: RespondOptions,
): Promise<void> {
  await interaction.responder.send(
    {
      ...(options.content === undefined ? {} : { content: options.content }),
      ...(options.embeds === undefined ? {} : { embeds: options.embeds }),
      ...(options.components === undefined ? {} : { components: options.components }),
    },
    { ephemeral: options.ephemeral ?? true },
  );
}

/** Aggiorna il messaggio che contiene il componente cliccato. */
export async function updateMessage(
  interaction: InteractionContext,
  options: { embeds?: ReplyEmbeds; components?: ReplyComponents; content?: string },
): Promise<void> {
  await interaction.responder.update({
    ...(options.content === undefined ? {} : { content: options.content }),
    embeds: options.embeds ?? [],
    components: options.components ?? [],
  });
}
