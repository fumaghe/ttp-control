/**
 * Contratti per comandi e handler di interaction.
 *
 * Nessun tipo di discord.js: gli handler ricevono `InteractionContext`, il
 * DTO applicativo. La business logic non sa da quale trasporto sia arrivata
 * l'interaction.
 */
import type { RESTPostAPIChatInputApplicationCommandsJSONBody } from 'discord-api-types/v10';
import type { InteractionContext } from '../http/interactionContext.js';
import type { ParsedCustomId } from '../utils/customId.js';
import type { AppContext } from './context.js';

export interface SlashCommand {
  /** Nome di primo livello, per il routing. */
  readonly name: string;
  /** Payload gia' serializzato per la registrazione. */
  readonly data: RESTPostAPIChatInputApplicationCommandsJSONBody;
  execute(interaction: InteractionContext, ctx: AppContext): Promise<void>;
  autocomplete?(interaction: InteractionContext, ctx: AppContext): Promise<void>;
}

export interface ComponentHandler {
  /** Namespace del `customId` gestito. */
  readonly namespace: string;
  handle(interaction: InteractionContext, parsed: ParsedCustomId, ctx: AppContext): Promise<void>;
}

export interface ModalHandler {
  readonly namespace: string;
  handle(interaction: InteractionContext, parsed: ParsedCustomId, ctx: AppContext): Promise<void>;
}
