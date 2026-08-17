/**
 * Router delle interaction HTTP.
 *
 * Sostituisce l'evento `interactionCreate` del Gateway: unico punto
 * d'ingresso, da qui si smista verso comandi, componenti e modal.
 *
 * Ogni percorso è avvolto in un `try/catch`, così nessuna eccezione lascia
 * l'utente davanti a "L'applicazione non ha risposto".
 */
import { InteractionType } from 'discord-api-types/v10';
import {
  commandsByName,
  componentsByNamespace,
  modalsByNamespace,
} from '../interactions/registry.js';
import { handleInteractionError } from '../errors/handleInteractionError.js';
import type { AppContext } from '../types/context.js';
import { parseCustomId } from '../utils/customId.js';
import { createLogger } from '../utils/logger.js';
import type { InteractionContext } from './interactionContext.js';

const log = createLogger('interaction');

export async function routeInteraction(
  interaction: InteractionContext,
  ctx: AppContext,
): Promise<void> {
  // Il bot opera su una sola guild: le interaction da altrove vengono
  // ignorate invece di essere processate con la configurazione sbagliata.
  // È anche una difesa: l'app potrebbe essere invitata altrove.
  if (interaction.guildId !== null && interaction.guildId !== ctx.guildId) {
    log.warn({ guildId: interaction.guildId }, 'Interaction da una guild non gestita');
    await interaction.responder.send(
      { content: 'Questo bot è configurato per un altro server.' },
      { ephemeral: true },
    );
    return;
  }

  switch (interaction.type) {
    case InteractionType.ApplicationCommand:
      await routeCommand(interaction, ctx);
      return;

    case InteractionType.ApplicationCommandAutocomplete:
      await routeAutocomplete(interaction, ctx);
      return;

    case InteractionType.MessageComponent:
      await routeComponent(interaction, ctx);
      return;

    case InteractionType.ModalSubmit:
      await routeModal(interaction, ctx);
      return;

    // Il PING viene gestito dal Worker prima del routing: qui non arriva mai.
    case InteractionType.Ping:
    default:
      log.warn({ type: interaction.type }, 'Tipo di interaction non gestito');
      interaction.responder.settle();
  }
}

async function routeCommand(interaction: InteractionContext, ctx: AppContext): Promise<void> {
  const command = commandsByName.get(interaction.commandName);
  if (!command) {
    log.warn({ command: interaction.commandName }, 'Comando sconosciuto');
    await interaction.responder.send({
      content: 'Comando non riconosciuto. Potrebbe essere stato rimosso.',
    });
    return;
  }

  try {
    await command.execute(interaction, ctx);
  } catch (error) {
    await handleInteractionError(interaction, error, {
      operation: `/${interaction.commandName}`,
      actorDiscordId: interaction.actorDiscordId,
    });
  }
}

async function routeAutocomplete(interaction: InteractionContext, ctx: AppContext): Promise<void> {
  const command = commandsByName.get(interaction.commandName);
  if (!command?.autocomplete) {
    await interaction.responder.autocomplete([]);
    return;
  }
  try {
    await command.autocomplete(interaction, ctx);
  } catch (error) {
    log.error({ err: error, command: interaction.commandName }, 'Autocomplete fallito');
    // Discord tollera un autocomplete vuoto meglio di uno mancante.
    await interaction.responder.autocomplete([]);
  }
}

async function routeComponent(interaction: InteractionContext, ctx: AppContext): Promise<void> {
  // Un customId malformato può arrivare da un client manipolato: si rifiuta
  // invece di provare a interpretarlo.
  const parsed = parseCustomId(interaction.customId ?? '');
  if (!parsed) {
    log.warn({ customId: interaction.customId }, 'customId non valido');
    await interaction.responder.send({ content: 'Questa interazione non è più valida.' });
    return;
  }

  const handler = componentsByNamespace.get(parsed.namespace);
  if (!handler) {
    log.warn({ namespace: parsed.namespace }, 'Nessun handler per il namespace');
    await interaction.responder.send({ content: 'Questa interazione non è più valida.' });
    return;
  }

  try {
    await handler.handle(interaction, parsed, ctx);
  } catch (error) {
    await handleInteractionError(interaction, error, {
      operation: `component:${parsed.namespace}:${parsed.action}`,
      actorDiscordId: interaction.actorDiscordId,
    });
  }
}

async function routeModal(interaction: InteractionContext, ctx: AppContext): Promise<void> {
  const parsed = parseCustomId(interaction.customId ?? '');
  if (!parsed) {
    log.warn({ customId: interaction.customId }, 'customId di modal non valido');
    await interaction.responder.send({ content: 'Questo modulo non è più valido.' });
    return;
  }

  const handler = modalsByNamespace.get(parsed.namespace);
  if (!handler) {
    await interaction.responder.send({ content: 'Questo modulo non è più valido.' });
    return;
  }

  try {
    await handler.handle(interaction, parsed, ctx);
  } catch (error) {
    await handleInteractionError(interaction, error, {
      operation: `modal:${parsed.namespace}:${parsed.action}`,
      actorDiscordId: interaction.actorDiscordId,
    });
  }
}
