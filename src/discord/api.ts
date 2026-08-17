/**
 * Tipi minimi dell'API Discord usati dal bot.
 *
 * Volutamente parziali: descrivono solo i campi che il codice legge davvero.
 * Ogni risposta viene comunque validata prima dell'uso (vedi `rest.ts` e
 * `gateway.ts`): un payload che arriva dalla rete non e' un tipo, e'
 * un'ipotesi.
 */

/** Snowflake Discord. Alias documentale: resta una stringa. */
export type Snowflake = string;

export interface ApiUser {
  readonly id: Snowflake;
  readonly username: string;
  readonly global_name?: string | null;
  readonly discriminator?: string;
  readonly bot?: boolean;
}

export interface ApiGuildMember {
  readonly user?: ApiUser;
  readonly nick?: string | null;
  readonly roles: readonly Snowflake[];
  readonly joined_at?: string | null;
  readonly permissions?: string;
}

export interface ApiRole {
  readonly id: Snowflake;
  readonly name: string;
  readonly position: number;
  readonly permissions: string;
  readonly managed: boolean;
}

export interface ApiPermissionOverwrite {
  readonly id: Snowflake;
  /** 0 = ruolo, 1 = membro. */
  readonly type: 0 | 1;
  readonly allow: string;
  readonly deny: string;
}

export interface ApiChannel {
  readonly id: Snowflake;
  readonly name?: string;
  readonly type: number;
  readonly permission_overwrites?: readonly ApiPermissionOverwrite[];
}

export interface ApiGuild {
  readonly id: Snowflake;
  readonly name: string;
  readonly owner_id: Snowflake;
  readonly roles?: readonly ApiRole[];
  readonly approximate_member_count?: number;
}

export interface ApiMessage {
  readonly id: Snowflake;
  readonly channel_id: Snowflake;
}

export interface ApiChannelWithRecipient extends ApiChannel {
  readonly recipients?: readonly ApiUser[];
}

/** Tipi di canale che il bot sa usare come destinazione di un messaggio. */
export const CHANNEL_TYPE = {
  GUILD_TEXT: 0,
  DM: 1,
  GUILD_ANNOUNCEMENT: 5,
} as const;

/**
 * Codici d'errore JSON di Discord su cui il codice prende decisioni.
 * @see https://discord.com/developers/docs/topics/opcodes-and-status-codes
 */
export const DISCORD_ERROR_CODE = {
  UNKNOWN_CHANNEL: 10003,
  UNKNOWN_GUILD: 10004,
  UNKNOWN_MEMBER: 10007,
  UNKNOWN_MESSAGE: 10008,
  UNKNOWN_USER: 10013,
  MISSING_ACCESS: 50001,
  MISSING_PERMISSIONS: 50013,
  CANNOT_SEND_DM: 50007,
} as const;

/** Bit dei permessi che il bot verifica. I permessi sono un bitfield a 64 bit. */
export const PERMISSION = {
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  MANAGE_NICKNAMES: 1n << 27n,
  MANAGE_ROLES: 1n << 28n,
  EMBED_LINKS: 1n << 14n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  ADMINISTRATOR: 1n << 3n,
} as const;

/** Converte la stringa decimale dei permessi Discord in bitfield. */
export function toPermissionBits(raw: string | undefined): bigint {
  if (!raw) return 0n;
  try {
    return BigInt(raw);
  } catch {
    return 0n;
  }
}

export function hasPermission(bits: bigint, permission: bigint): boolean {
  if ((bits & PERMISSION.ADMINISTRATOR) === PERMISSION.ADMINISTRATOR) return true;
  return (bits & permission) === permission;
}

/**
 * Permessi effettivi di un membro a livello di guild.
 *
 * `@everyone` ha come ID quello della guild: e' una convenzione dell'API, non
 * un caso particolare del nostro codice.
 */
export function computeGuildPermissions(
  guildId: Snowflake,
  roles: readonly ApiRole[],
  memberRoleIds: readonly Snowflake[],
  isGuildOwner: boolean,
): bigint {
  if (isGuildOwner) return PERMISSION.ADMINISTRATOR;

  const byId = new Map(roles.map((role) => [role.id, role]));
  let bits = toPermissionBits(byId.get(guildId)?.permissions);

  for (const roleId of memberRoleIds) {
    bits |= toPermissionBits(byId.get(roleId)?.permissions);
  }
  return bits;
}

/**
 * Permessi effettivi in un canale, applicando gli overwrite nell'ordine
 * previsto da Discord: `@everyone`, poi l'unione dei ruoli, poi il membro.
 */
export function computeChannelPermissions(
  guildId: Snowflake,
  channel: ApiChannel,
  basePermissions: bigint,
  memberId: Snowflake,
  memberRoleIds: readonly Snowflake[],
): bigint {
  if ((basePermissions & PERMISSION.ADMINISTRATOR) === PERMISSION.ADMINISTRATOR) {
    return PERMISSION.ADMINISTRATOR;
  }

  const overwrites = channel.permission_overwrites ?? [];
  let permissions = basePermissions;

  const everyone = overwrites.find((o) => o.id === guildId);
  if (everyone) {
    permissions &= ~toPermissionBits(everyone.deny);
    permissions |= toPermissionBits(everyone.allow);
  }

  // I ruoli si accumulano prima di essere applicati: un deny su un ruolo non
  // deve cancellare un allow su un altro.
  let allow = 0n;
  let deny = 0n;
  for (const overwrite of overwrites) {
    if (overwrite.type !== 0 || overwrite.id === guildId) continue;
    if (!memberRoleIds.includes(overwrite.id)) continue;
    deny |= toPermissionBits(overwrite.deny);
    allow |= toPermissionBits(overwrite.allow);
  }
  permissions &= ~deny;
  permissions |= allow;

  const member = overwrites.find((o) => o.type === 1 && o.id === memberId);
  if (member) {
    permissions &= ~toPermissionBits(member.deny);
    permissions |= toPermissionBits(member.allow);
  }

  return permissions;
}
