/**
 * Router delle interaction.
 *
 * Unico punto d'ingresso: da qui si smista verso comandi, componenti e modal.
 * Ogni percorso è avvolto in un `try/catch`, così nessuna eccezione lascia
 * l'utente davanti a "L'applicazione non ha risposto".
 */
import { type Interaction, MessageFlags } from 'discord.js';
import { commandsByName, componentsByNamespace, modalsByNamespace } from '../client/registry.js';
import { handleInteractionError } from '../errors/handleInteractionError.js';
import type { AppContext } from '../types/context.js';
import { parseCustomId } from '../utils/customId.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('interaction');

export async function handleInteraction(interaction: Interaction, ctx: AppContext): Promise<void> {
  // Il bot opera su una sola guild: le interaction da altrove vengono
  // ignorate invece di essere processate con la configurazione sbagliata.
  if (interaction.guildId !== null && interaction.guildId !== ctx.guild.id) {
    log.warn({ guildId: interaction.guildId }, 'Interaction da una guild non gestita');
    return;
  }

  // --- Slash command ---------------------------------------------------
  if (interaction.isChatInputCommand()) {
    const command = commandsByName.get(interaction.commandName);
    if (!command) {
      log.warn({ command: interaction.commandName }, 'Comando sconosciuto');
      await interaction.reply({
        content: 'Comando non riconosciuto. Potrebbe essere stato rimosso.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    try {
      await command.execute(interaction, ctx);
    } catch (error) {
      await handleInteractionError(interaction, error, {
        operation: `/${interaction.commandName}`,
        actorDiscordId: interaction.user.id,
      });
    }
    return;
  }

  // --- Autocomplete -------------------------------------------------------
  if (interaction.isAutocomplete()) {
    const command = commandsByName.get(interaction.commandName);
    if (!command?.autocomplete) return;
    try {
      await command.autocomplete(interaction, ctx);
    } catch (error) {
      log.error({ err: error, command: interaction.commandName }, 'Autocomplete fallito');
      // Discord tollera un autocomplete vuoto meglio di uno mancante.
      await interaction.respond([]).catch(() => undefined);
    }
    return;
  }

  // --- Componenti (bottoni e select) --------------------------------------
  if (
    interaction.isButton() ||
    interaction.isStringSelectMenu() ||
    interaction.isUserSelectMenu()
  ) {
    // Un customId malformato può arrivare da un client manipolato: si ignora
    // in silenzio invece di provare a interpretarlo.
    const parsed = parseCustomId(interaction.customId);
    if (!parsed) {
      log.warn({ customId: interaction.customId }, 'customId non valido');
      await interaction
        .reply({
          content: 'Questa interazione non è più valida.',
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => undefined);
      return;
    }

    const handler = componentsByNamespace.get(parsed.namespace);
    if (!handler) {
      log.warn({ namespace: parsed.namespace }, 'Nessun handler per il namespace');
      return;
    }

    try {
      await handler.handle(interaction, parsed, ctx);
    } catch (error) {
      await handleInteractionError(interaction, error, {
        operation: `component:${parsed.namespace}:${parsed.action}`,
        actorDiscordId: interaction.user.id,
      });
    }
    return;
  }

  // --- Modal ---------------------------------------------------------------
  if (interaction.isModalSubmit()) {
    const parsed = parseCustomId(interaction.customId);
    if (!parsed) {
      log.warn({ customId: interaction.customId }, 'customId di modal non valido');
      return;
    }

    const handler = modalsByNamespace.get(parsed.namespace);
    if (!handler) return;

    try {
      await handler.handle(interaction, parsed, ctx);
    } catch (error) {
      await handleInteractionError(interaction, error, {
        operation: `modal:${parsed.namespace}:${parsed.action}`,
        actorDiscordId: interaction.user.id,
      });
    }
  }
}
