/**
 * Contratti per comandi e handler di interaction.
 */
import type {
  AutocompleteInteraction,
  ButtonInteraction,
  ChatInputCommandInteraction,
  ModalSubmitInteraction,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
  StringSelectMenuInteraction,
  UserSelectMenuInteraction,
} from 'discord.js';
import type { ParsedCustomId } from '../utils/customId.js';
import type { AppContext } from './context.js';

export interface SlashCommand {
  /** Nome di primo livello, per il routing. */
  readonly name: string;
  /** Payload gia' serializzato per la registrazione. */
  readonly data: RESTPostAPIChatInputApplicationCommandsJSONBody;
  execute(interaction: ChatInputCommandInteraction, ctx: AppContext): Promise<void>;
  autocomplete?(interaction: AutocompleteInteraction, ctx: AppContext): Promise<void>;
}

export type ComponentInteraction =
  ButtonInteraction | StringSelectMenuInteraction | UserSelectMenuInteraction;

export interface ComponentHandler {
  /** Namespace del `customId` gestito. */
  readonly namespace: string;
  handle(interaction: ComponentInteraction, parsed: ParsedCustomId, ctx: AppContext): Promise<void>;
}

export interface ModalHandler {
  readonly namespace: string;
  handle(
    interaction: ModalSubmitInteraction,
    parsed: ParsedCustomId,
    ctx: AppContext,
  ): Promise<void>;
}
