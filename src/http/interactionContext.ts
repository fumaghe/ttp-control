/**
 * InteractionContext — il DTO applicativo di una interaction.
 *
 * È l'adapter che separa la business logic dal trasporto: comandi e handler
 * non conoscono più `ChatInputCommandInteraction`, `ButtonInteraction`,
 * `Guild` o `GuildMember`. Ricevono questo oggetto, che espone solo dati già
 * normalizzati e i pochi helper di risposta necessari.
 *
 * Conseguenza pratica: la stessa logica funziona con le interaction HTTP del
 * Worker e resterebbe valida con qualsiasi altro trasporto, perché non c'è
 * più niente di specifico di una libreria dentro gli handler.
 */
import {
  ApplicationCommandOptionType,
  ComponentType,
  InteractionType,
  type APIApplicationCommandInteractionDataOption,
  type APIChatInputApplicationCommandInteractionData,
  type APIInteraction,
  type APIInteractionDataResolved,
  type APIUser,
} from 'discord-api-types/v10';
import { ValidationError } from '../errors/AppError.js';
import type { InteractionResponder } from './responder.js';

/** Un utente Discord, ridotto a ciò che serve al dominio. */
export interface InteractionUser {
  readonly id: string;
  readonly username: string;
  /** Nickname nella guild, oppure global name, oppure username. */
  readonly displayName: string;
}

export interface InteractionRole {
  readonly id: string;
  readonly name: string;
}

/** Accesso alle opzioni di uno slash command. */
export interface InteractionOptions {
  getSubcommand(required: true): string;
  getSubcommand(required?: boolean): string | null;
  getString(name: string, required: true): string;
  getString(name: string, required?: boolean): string | null;
  getInteger(name: string, required: true): number;
  getInteger(name: string, required?: boolean): number | null;
  getBoolean(name: string, required: true): boolean;
  getBoolean(name: string, required?: boolean): boolean | null;
  getUser(name: string, required: true): InteractionUser;
  getUser(name: string, required?: boolean): InteractionUser | null;
  getRole(name: string, required: true): InteractionRole;
  getRole(name: string, required?: boolean): InteractionRole | null;
  /** Opzione con il focus in un autocomplete. */
  getFocused(): { readonly name: string; readonly value: string } | null;
}

/** Accesso ai campi di un modal. */
export interface InteractionFields {
  /** @returns stringa vuota se il campo non è stato compilato. */
  getTextInputValue(customId: string): string;
}

export interface InteractionContext {
  readonly type: InteractionType;

  /* --- Identità dell'interaction ---------------------------------------- */
  readonly interactionId: string;
  readonly interactionToken: string;
  readonly applicationId: string;

  /* --- Contesto Discord --------------------------------------------------- */
  readonly guildId: string | null;
  readonly channelId: string | null;

  /* --- Attore ------------------------------------------------------------- */
  readonly actorDiscordId: string;
  /** Alias ergonomico di `actorDiscordId` e dei suoi nomi. */
  readonly user: InteractionUser;
  /** Ruoli posseduti dall'attore al momento del click, secondo Discord. */
  readonly memberRoleIds: readonly string[];

  /* --- Payload ------------------------------------------------------------ */
  readonly commandName: string;
  readonly customId: string | null;
  /** Valori selezionati in una select menu. */
  readonly values: readonly string[];
  readonly componentType: ComponentType | null;

  readonly options: InteractionOptions;
  readonly fields: InteractionFields;

  isButton(): boolean;
  isStringSelectMenu(): boolean;
  isUserSelectMenu(): boolean;

  /* --- Risposte ----------------------------------------------------------- */
  readonly responder: InteractionResponder;
  readonly deferred: boolean;
  readonly replied: boolean;
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                     */
/* -------------------------------------------------------------------------- */

type OptionList = readonly APIApplicationCommandInteractionDataOption[];

interface FlattenedOptions {
  readonly subcommand: string | null;
  readonly byName: ReadonlyMap<string, APIApplicationCommandInteractionDataOption>;
}

/**
 * Appiattisce le opzioni scendendo dentro subcommand e gruppi.
 *
 * Discord annida le opzioni sotto il subcommand; gli handler vogliono
 * `getString('reason')` senza doverlo sapere.
 */
function flattenOptions(options: OptionList | undefined): FlattenedOptions {
  const byName = new Map<string, APIApplicationCommandInteractionDataOption>();
  let subcommand: string | null = null;
  let current = options ?? [];

  // Al massimo due livelli: gruppo → subcommand → opzioni.
  for (let depth = 0; depth < 2; depth += 1) {
    const nested = current.find(
      (option) =>
        option.type === ApplicationCommandOptionType.Subcommand ||
        option.type === ApplicationCommandOptionType.SubcommandGroup,
    );
    if (!nested) break;
    if (nested.type === ApplicationCommandOptionType.Subcommand) subcommand = nested.name;
    current = nested.options ?? [];
  }

  for (const option of current) byName.set(option.name, option);
  return { subcommand, byName };
}

function displayNameOf(user: APIUser, resolved: APIInteractionDataResolved | undefined): string {
  const nick = resolved?.members?.[user.id]?.nick;
  return nick ?? user.global_name ?? user.username;
}

function buildOptions(
  data: APIChatInputApplicationCommandInteractionData | undefined,
  resolved: APIInteractionDataResolved | undefined,
): InteractionOptions {
  const { subcommand, byName } = flattenOptions(data?.options);

  function required<T>(value: T | null, name: string, isRequired: boolean | undefined): T {
    if (value === null && isRequired === true) {
      // Discord garantisce le opzioni obbligatorie, ma il payload arriva dalla
      // rete: se manca è un errore di protocollo, non un caso di dominio.
      throw new ValidationError(`Opzione obbligatoria mancante: **${name}**.`);
    }
    return value as T;
  }

  function raw(name: string): APIApplicationCommandInteractionDataOption | undefined {
    return byName.get(name);
  }

  return {
    getSubcommand(isRequired?: boolean): string {
      return required(subcommand, 'sottocomando', isRequired);
    },

    getString(name: string, isRequired?: boolean): string {
      const option = raw(name);
      const value = option?.type === ApplicationCommandOptionType.String ? option.value : null;
      return required(value, name, isRequired);
    },

    getInteger(name: string, isRequired?: boolean): number {
      const option = raw(name);
      const value: number | null =
        option?.type === ApplicationCommandOptionType.Integer && typeof option.value === 'number'
          ? option.value
          : null;
      return required(value, name, isRequired);
    },

    getBoolean(name: string, isRequired?: boolean): boolean {
      const option = raw(name);
      const value = option?.type === ApplicationCommandOptionType.Boolean ? option.value : null;
      return required(value, name, isRequired);
    },

    getUser(name: string, isRequired?: boolean): InteractionUser {
      const option = raw(name);
      const id =
        option?.type === ApplicationCommandOptionType.User ||
        option?.type === ApplicationCommandOptionType.Mentionable
          ? option.value
          : null;

      const user = id === null ? undefined : resolved?.users?.[id];
      const value: InteractionUser | null = user
        ? { id: user.id, username: user.username, displayName: displayNameOf(user, resolved) }
        : // L'utente può non essere risolvibile (account cancellato): l'ID
          // resta comunque utilizzabile e vale più di un `null`.
          id === null
          ? null
          : { id, username: id, displayName: id };

      return required(value, name, isRequired);
    },

    getRole(name: string, isRequired?: boolean): InteractionRole {
      const option = raw(name);
      const id =
        option?.type === ApplicationCommandOptionType.Role ||
        option?.type === ApplicationCommandOptionType.Mentionable
          ? option.value
          : null;

      const role = id === null ? undefined : resolved?.roles?.[id];
      const value: InteractionRole | null = id === null ? null : { id, name: role?.name ?? id };

      return required(value, name, isRequired);
    },

    getFocused(): { name: string; value: string } | null {
      for (const option of byName.values()) {
        if (
          option.type === ApplicationCommandOptionType.String &&
          'focused' in option &&
          option.focused
        ) {
          return { name: option.name, value: option.value };
        }
      }
      return null;
    },
  };
}

function buildFields(interaction: APIInteraction): InteractionFields {
  const values = new Map<string, string>();

  if (interaction.type === InteractionType.ModalSubmit) {
    collectModalValues(interaction.data.components, values);
  }

  return {
    getTextInputValue: (customId) => values.get(customId) ?? '',
  };
}

/**
 * Raccoglie i valori dei campi di un modal.
 *
 * Discord ha più forme di contenitore (action row storiche, `label` dei
 * componenti v2 usati dal progetto): invece di codificarle una per una si
 * scende ricorsivamente cercando i `custom_id` con un `value`.
 */
function collectModalValues(components: readonly unknown[], into: Map<string, string>): void {
  for (const component of components) {
    if (typeof component !== 'object' || component === null) continue;
    const node = component as {
      custom_id?: unknown;
      value?: unknown;
      components?: unknown;
      component?: unknown;
    };

    if (typeof node.custom_id === 'string' && typeof node.value === 'string') {
      into.set(node.custom_id, node.value);
    }
    if (Array.isArray(node.components)) collectModalValues(node.components, into);
    if (node.component !== undefined) collectModalValues([node.component], into);
  }
}

function actorOf(interaction: APIInteraction): {
  user: InteractionUser;
  roleIds: readonly string[];
} {
  const member = 'member' in interaction ? interaction.member : undefined;
  const apiUser = member?.user ?? interaction.user;

  if (!apiUser) {
    // Non può accadere con un payload Discord valido: se accade, il payload
    // non è di Discord e non deve proseguire.
    throw new ValidationError('Interaction priva di utente.');
  }

  return {
    user: {
      id: apiUser.id,
      username: apiUser.username,
      displayName: member?.nick ?? apiUser.global_name ?? apiUser.username,
    },
    roleIds: member?.roles ?? [],
  };
}

export interface BuildContextInput {
  readonly interaction: APIInteraction;
  readonly responder: InteractionResponder;
}

/** Costruisce il DTO applicativo a partire dal payload Discord grezzo. */
export function buildInteractionContext(input: BuildContextInput): InteractionContext {
  const { interaction, responder } = input;
  const { user, roleIds } = actorOf(interaction);

  const commandData =
    interaction.type === InteractionType.ApplicationCommand ||
    interaction.type === InteractionType.ApplicationCommandAutocomplete
      ? interaction.data
      : undefined;

  const chatInput =
    commandData && 'options' in commandData
      ? (commandData as APIChatInputApplicationCommandInteractionData)
      : undefined;

  const resolved = chatInput && 'resolved' in chatInput ? chatInput.resolved : undefined;

  const component =
    interaction.type === InteractionType.MessageComponent ? interaction.data : undefined;

  const customId =
    component?.custom_id ??
    (interaction.type === InteractionType.ModalSubmit ? interaction.data.custom_id : null);

  const values =
    component?.component_type === ComponentType.StringSelect ||
    component?.component_type === ComponentType.UserSelect
      ? ((component as { values?: readonly string[] }).values ?? [])
      : [];

  return {
    type: interaction.type,

    interactionId: interaction.id,
    interactionToken: interaction.token,
    applicationId: interaction.application_id,

    guildId: interaction.guild_id ?? null,
    channelId: interaction.channel?.id ?? null,

    actorDiscordId: user.id,
    user,
    memberRoleIds: roleIds,

    commandName: commandData?.name ?? '',
    customId,
    values,
    componentType: component?.component_type ?? null,

    options: buildOptions(chatInput, resolved),
    fields: buildFields(interaction),

    isButton: () => component?.component_type === ComponentType.Button,
    isStringSelectMenu: () => component?.component_type === ComponentType.StringSelect,
    isUserSelectMenu: () => component?.component_type === ComponentType.UserSelect,

    responder,
    get deferred(): boolean {
      return responder.deferred;
    },
    get replied(): boolean {
      return responder.replied;
    },
  };
}
