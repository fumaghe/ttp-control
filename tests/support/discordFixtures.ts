/**
 * Fixture per i test del livello HTTP e del gateway REST.
 *
 * Producono payload nella stessa forma che Discord invia davvero, così i
 * test verificano il parsing reale e non una versione semplificata inventata
 * per far passare il codice.
 */
import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ComponentType,
  InteractionType,
  type APIInteraction,
} from 'discord-api-types/v10';

export const TEST_APPLICATION_ID = '100000000000000003';
export const TEST_GUILD_ID = '100000000000000001';
export const TEST_ACTOR_ID = '400000000000000001';
export const TEST_CHANNEL_ID = '300000000000000001';

const ACTOR = {
  id: TEST_ACTOR_ID,
  username: 'tony',
  global_name: 'Tony Montana',
  discriminator: '0',
  avatar: null,
};

function base(): Record<string, unknown> {
  return {
    id: '900000000000000001',
    application_id: TEST_APPLICATION_ID,
    token: 'interaction-token',
    version: 1,
    guild_id: TEST_GUILD_ID,
    locale: 'it',
    app_permissions: '0',
    channel: { id: TEST_CHANNEL_ID, type: 0 },
    member: {
      user: ACTOR,
      nick: 'Tony',
      roles: ['200000000000000002'],
      joined_at: '2026-01-01T00:00:00.000Z',
      deaf: false,
      mute: false,
      flags: 0,
    },
  };
}

export interface CommandOptionsInput {
  readonly subcommand?: string;
  readonly strings?: Readonly<Record<string, string>>;
  readonly booleans?: Readonly<Record<string, boolean>>;
  readonly users?: Readonly<Record<string, { id: string; username: string; nick?: string }>>;
}

/** Slash command, eventualmente con subcommand e opzioni risolte. */
export function chatInputInteraction(
  name: string,
  input: CommandOptionsInput = {},
): APIInteraction {
  const leafOptions: unknown[] = [
    ...Object.entries(input.strings ?? {}).map(([key, value]) => ({
      name: key,
      type: ApplicationCommandOptionType.String,
      value,
    })),
    ...Object.entries(input.booleans ?? {}).map(([key, value]) => ({
      name: key,
      type: ApplicationCommandOptionType.Boolean,
      value,
    })),
    ...Object.entries(input.users ?? {}).map(([key, value]) => ({
      name: key,
      type: ApplicationCommandOptionType.User,
      value: value.id,
    })),
  ];

  const users: Record<string, unknown> = {};
  const members: Record<string, unknown> = {};
  for (const value of Object.values(input.users ?? {})) {
    users[value.id] = {
      id: value.id,
      username: value.username,
      global_name: value.username,
      discriminator: '0',
      avatar: null,
    };
    if (value.nick !== undefined) members[value.id] = { nick: value.nick, roles: [] };
  }

  return {
    ...base(),
    type: InteractionType.ApplicationCommand,
    data: {
      id: '800000000000000001',
      name,
      type: ApplicationCommandType.ChatInput,
      ...(input.subcommand === undefined
        ? { options: leafOptions }
        : {
            options: [
              {
                name: input.subcommand,
                type: ApplicationCommandOptionType.Subcommand,
                options: leafOptions,
              },
            ],
          }),
      resolved: { users, members },
    },
  } as unknown as APIInteraction;
}

export function buttonInteraction(customId: string): APIInteraction {
  return {
    ...base(),
    type: InteractionType.MessageComponent,
    message: { id: '950000000000000001' },
    data: { custom_id: customId, component_type: ComponentType.Button },
  } as unknown as APIInteraction;
}

export function selectMenuInteraction(customId: string, values: string[]): APIInteraction {
  return {
    ...base(),
    type: InteractionType.MessageComponent,
    message: { id: '950000000000000001' },
    data: { custom_id: customId, component_type: ComponentType.StringSelect, values },
  } as unknown as APIInteraction;
}

/**
 * Modal submit nella forma dei componenti v2 usati dal progetto: ogni campo
 * è avvolto in un `label`, non in una action row.
 */
export function modalInteraction(
  customId: string,
  fields: Readonly<Record<string, string>>,
): APIInteraction {
  return {
    ...base(),
    type: InteractionType.ModalSubmit,
    data: {
      custom_id: customId,
      components: Object.entries(fields).map(([key, value]) => ({
        type: ComponentType.Label,
        component: { type: ComponentType.TextInput, custom_id: key, value },
      })),
    },
  } as unknown as APIInteraction;
}

export function autocompleteInteraction(name: string, focused: string): APIInteraction {
  return {
    ...base(),
    type: InteractionType.ApplicationCommandAutocomplete,
    data: {
      id: '800000000000000002',
      name,
      type: ApplicationCommandType.ChatInput,
      options: [
        {
          name: 'query',
          type: ApplicationCommandOptionType.String,
          value: focused,
          focused: true,
        },
      ],
    },
  } as unknown as APIInteraction;
}

export function pingInteraction(): APIInteraction {
  return {
    id: '900000000000000002',
    application_id: TEST_APPLICATION_ID,
    token: 'ping-token',
    version: 1,
    type: InteractionType.Ping,
  } as unknown as APIInteraction;
}

/* -------------------------------------------------------------------------- */
/* Fake REST                                                                   */
/* -------------------------------------------------------------------------- */

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly reason: string | undefined;
  readonly auth: boolean;
}

export interface FakeRest {
  readonly requests: RecordedRequest[];
  /** Risposte per `METODO percorso`; le funzioni ricevono il body. */
  readonly routes: Map<string, (body: unknown) => unknown>;
  request<T>(options: {
    method: string;
    path: string;
    body?: unknown;
    reason?: string | undefined;
    auth?: boolean;
    query?: Readonly<Record<string, string | number | undefined>> | undefined;
  }): Promise<T>;
  get<T>(path: string, query?: Readonly<Record<string, string | number | undefined>>): Promise<T>;
  post<T>(path: string, body: unknown, reason?: string): Promise<T>;
  patch<T>(path: string, body: unknown, reason?: string): Promise<T>;
  put<T>(path: string, body: unknown, reason?: string): Promise<T>;
  delete<T>(path: string, reason?: string): Promise<T>;
  unauthenticated<T>(options: {
    method: string;
    path: string;
    body?: unknown;
    query?: Readonly<Record<string, string | number | undefined>> | undefined;
  }): Promise<T>;
}

/**
 * Doppio del client REST.
 *
 * Registra ogni richiesta e restituisce quello che la rotta corrispondente
 * dichiara. Serve a verificare COSA il gateway manda a Discord — che è
 * l'unica cosa che conta di un adapter.
 */
export function createFakeRest(routes: Record<string, unknown> = {}): FakeRest {
  const map = new Map<string, (body: unknown) => unknown>();
  for (const [key, value] of Object.entries(routes)) {
    map.set(key, typeof value === 'function' ? (value as (body: unknown) => unknown) : () => value);
  }

  const rest: FakeRest = {
    requests: [],
    routes: map,

    request<T>(options: {
      method: string;
      path: string;
      body?: unknown;
      reason?: string | undefined;
      auth?: boolean;
      query?: Readonly<Record<string, string | number | undefined>> | undefined;
    }): Promise<T> {
      rest.requests.push({
        method: options.method,
        path: options.path,
        body: options.body,
        reason: options.reason,
        auth: options.auth ?? true,
      });

      const handler = rest.routes.get(`${options.method} ${options.path}`);
      return Promise.resolve((handler ? handler(options.body) : undefined) as T);
    },

    get: (path, query) => rest.request({ method: 'GET', path, ...(query ? { query } : {}) }),
    post: (path, body, reason) => rest.request({ method: 'POST', path, body, reason }),
    patch: (path, body, reason) => rest.request({ method: 'PATCH', path, body, reason }),
    put: (path, body, reason) => rest.request({ method: 'PUT', path, body, reason }),
    delete: (path, reason) => rest.request({ method: 'DELETE', path, reason }),
    unauthenticated: (options) => rest.request({ ...options, auth: false }),
  };

  return rest;
}
