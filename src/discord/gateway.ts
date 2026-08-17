/**
 * DiscordRestGateway — adapter centralizzato verso l'API Discord.
 *
 *   Service → DiscordGateway (interfaccia) → DiscordRestGateway → Discord HTTP
 *
 * Sostituisce integralmente `src/client/discordRoleGateway.ts` della V1, che
 * lavorava sulla cache della guild di discord.js. Qui non c'e' nessuna cache
 * di processo: il Worker e' stateless e ogni invocazione parte da zero.
 * L'unica cache e' per-richiesta (ruoli, canali, membro-bot), perche' senza
 * un `/setup check` farebbe decine di chiamate identiche.
 *
 * E' l'unico file che sa come si compone una richiesta Discord per ruoli,
 * membri, messaggi e moderazione.
 */
import {
  type ApiChannel,
  type ApiGuild,
  type ApiGuildMember,
  type ApiMessage,
  type ApiRole,
  computeChannelPermissions,
  computeGuildPermissions,
  DISCORD_ERROR_CODE,
  type Snowflake,
} from './api.js';
import { type DiscordRest, isDiscordApiError, isNotFound } from './rest.js';
import {
  type ApiMessagePayload,
  type MessagePayload,
  toApiMessage,
  toApiMessageForEdit,
} from './payload.js';
import { AppError, ERROR_CODE } from '../errors/AppError.js';
import { EMBED_COLOR } from '../config/constants.js';
import { createLogger } from '../utils/logger.js';
import type { ModerationGateway } from '../services/blacklistService.js';
import type { GuildMemberSnapshot, RoleGateway } from '../services/roleGateway.js';
import type { PanelMessageGateway } from '../services/panelService.js';

const log = createLogger('discord-gateway');

/** Massimo consentito da Discord per `GET /guilds/{id}/members`. */
const MEMBER_PAGE_SIZE = 1000;

/**
 * Tetto di sicurezza sulle pagine di membri.
 *
 * Il Discord e' una singola guild privata: 10 pagine sono 10.000 membri,
 * abbondantemente sopra il reale. Serve a garantire che un bug di
 * paginazione non trasformi il cron in un ciclo infinito che brucia il
 * budget del piano gratuito.
 */
const MAX_MEMBER_PAGES = 10;

/** Operazioni Discord usate dai service. Un solo posto, un solo contratto. */
export interface DiscordGateway extends RoleGateway, ModerationGateway, PanelMessageGateway {
  readonly guildId: Snowflake;

  getGuild(): Promise<ApiGuild>;
  getRoles(): Promise<readonly ApiRole[]>;
  getChannels(): Promise<readonly ApiChannel[]>;
  /** Il membro che rappresenta il bot nella guild. */
  getSelfMember(): Promise<ApiGuildMember>;
  getSelfUserId(): Promise<Snowflake>;

  getMember(discordId: Snowflake): Promise<GuildMemberSnapshot | null>;
  /** Enumerazione completa, con paginazione. Richiede il Server Members Intent. */
  listMembers(): Promise<GuildMemberSnapshot[]>;
  listMembersWithAnyRole(roleIds: readonly Snowflake[]): Promise<GuildMemberSnapshot[]>;

  addRole(discordId: Snowflake, roleId: Snowflake, reason: string): Promise<void>;
  removeRole(discordId: Snowflake, roleId: Snowflake, reason: string): Promise<void>;
  setNickname(discordId: Snowflake, nickname: string | null, reason: string): Promise<void>;

  sendMessage(channelId: Snowflake, payload: MessagePayload): Promise<string>;
  editMessage(
    channelId: Snowflake,
    messageId: Snowflake,
    payload: MessagePayload,
  ): Promise<boolean>;
  getMessage(channelId: Snowflake, messageId: Snowflake): Promise<ApiMessage | null>;
  /** @returns `false` se l'utente ha i DM chiusi: non e' un errore. */
  sendDM(discordId: Snowflake, payload: MessagePayload): Promise<boolean>;

  /** Permessi effettivi del bot nella guild. */
  selfGuildPermissions(): Promise<bigint>;
  /** Permessi effettivi del bot in un canale, overwrite inclusi. */
  selfChannelPermissions(channelId: Snowflake): Promise<bigint | null>;
  /** Il bot puo' assegnare/rimuovere questo ruolo? */
  canManageRoleAsync(roleId: Snowflake): Promise<boolean>;
}

function snapshotOf(
  member: ApiGuildMember,
  rolePositions: ReadonlyMap<Snowflake, number>,
  guildOwnerId: Snowflake,
): GuildMemberSnapshot {
  const user = member.user;
  const discordId = user?.id ?? '';
  const username = user?.username ?? discordId;

  let highest = 0;
  for (const roleId of member.roles) {
    highest = Math.max(highest, rolePositions.get(roleId) ?? 0);
  }

  return {
    discordId,
    username,
    displayName: member.nick ?? user?.global_name ?? username,
    roleIds: new Set(member.roles),
    highestRolePosition: highest,
    isGuildOwner: discordId === guildOwnerId,
  };
}

export interface DiscordGatewayOptions {
  readonly rest: DiscordRest;
  readonly guildId: Snowflake;
  /** ID applicazione: e' anche lo user ID del bot. */
  readonly applicationId: Snowflake;
}

export function createDiscordRestGateway(options: DiscordGatewayOptions): DiscordGateway {
  const { rest, guildId, applicationId } = options;

  // --- Cache per-richiesta -------------------------------------------------
  // Il Worker vive quanto una singola interaction: memorizzare qui non
  // rischia di servire dati stantii, ed evita di rifare la stessa GET dieci
  // volte in un `/setup check`.
  let guildPromise: Promise<ApiGuild> | undefined;
  let rolesPromise: Promise<readonly ApiRole[]> | undefined;
  let channelsPromise: Promise<readonly ApiChannel[]> | undefined;
  let selfMemberPromise: Promise<ApiGuildMember> | undefined;

  function getGuild(): Promise<ApiGuild> {
    guildPromise ??= rest.get<ApiGuild>(`/guilds/${guildId}`);
    return guildPromise;
  }

  function getRoles(): Promise<readonly ApiRole[]> {
    rolesPromise ??= rest.get<ApiRole[]>(`/guilds/${guildId}/roles`);
    return rolesPromise;
  }

  function getChannels(): Promise<readonly ApiChannel[]> {
    channelsPromise ??= rest.get<ApiChannel[]>(`/guilds/${guildId}/channels`);
    return channelsPromise;
  }

  function getSelfMember(): Promise<ApiGuildMember> {
    selfMemberPromise ??= rest.get<ApiGuildMember>(`/guilds/${guildId}/members/${applicationId}`);
    return selfMemberPromise;
  }

  async function rolePositions(): Promise<Map<Snowflake, number>> {
    const roles = await getRoles();
    return new Map(roles.map((role) => [role.id, role.position]));
  }

  async function fetchMember(discordId: Snowflake): Promise<ApiGuildMember | null> {
    try {
      return await rest.get<ApiGuildMember>(`/guilds/${guildId}/members/${discordId}`);
    } catch (error) {
      if (isNotFound(error, DISCORD_ERROR_CODE.UNKNOWN_MEMBER, DISCORD_ERROR_CODE.UNKNOWN_USER)) {
        return null;
      }
      throw error;
    }
  }

  async function toSnapshot(member: ApiGuildMember): Promise<GuildMemberSnapshot> {
    const [positions, guild] = await Promise.all([rolePositions(), getGuild()]);
    return snapshotOf(member, positions, guild.owner_id);
  }

  async function selfHighestPosition(): Promise<number> {
    const [self, positions] = await Promise.all([getSelfMember(), rolePositions()]);
    let highest = 0;
    for (const roleId of self.roles) highest = Math.max(highest, positions.get(roleId) ?? 0);
    return highest;
  }

  /**
   * Discord non consente di gestire ruoli con posizione >= alla propria, ne'
   * i ruoli `managed` (creati da integrazioni).
   */
  async function canManageRoleAsync(roleId: Snowflake): Promise<boolean> {
    const roles = await getRoles();
    const role = roles.find((candidate) => candidate.id === roleId);
    if (!role || role.managed) return false;
    return (await selfHighestPosition()) > role.position;
  }

  async function selfGuildPermissions(): Promise<bigint> {
    const [self, roles, guild] = await Promise.all([getSelfMember(), getRoles(), getGuild()]);
    return computeGuildPermissions(guildId, roles, self.roles, applicationId === guild.owner_id);
  }

  async function selfChannelPermissions(channelId: Snowflake): Promise<bigint | null> {
    const channels = await getChannels();
    const channel = channels.find((candidate) => candidate.id === channelId);
    if (!channel) return null;
    const [self, base] = await Promise.all([getSelfMember(), selfGuildPermissions()]);
    return computeChannelPermissions(guildId, channel, base, applicationId, self.roles);
  }

  async function sendRaw(channelId: Snowflake, body: ApiMessagePayload): Promise<ApiMessage> {
    return rest.post<ApiMessage>(`/channels/${channelId}/messages`, body);
  }

  const gateway: DiscordGateway = {
    guildId,

    getGuild,
    getRoles,
    getChannels,
    getSelfMember,
    getSelfUserId: () => Promise.resolve(applicationId),

    // ---------------------------------------------------------------- membri
    async getMember(discordId): Promise<GuildMemberSnapshot | null> {
      const member = await fetchMember(discordId);
      return member ? toSnapshot(member) : null;
    },

    fetchMember(discordId): Promise<GuildMemberSnapshot | null> {
      return gateway.getMember(discordId);
    },

    /**
     * Enumerazione completa dei membri, paginata.
     *
     * `GET /guilds/{id}/members` richiede il **Server Members Intent** anche
     * via REST: e' l'intent privilegiato che resta abilitato nel Developer
     * Portal anche senza Gateway.
     */
    async listMembers(): Promise<GuildMemberSnapshot[]> {
      const [positions, guild] = await Promise.all([rolePositions(), getGuild()]);
      const snapshots: GuildMemberSnapshot[] = [];
      let after: Snowflake | undefined;

      for (let page = 0; page < MAX_MEMBER_PAGES; page += 1) {
        const batch = await rest.get<ApiGuildMember[]>(`/guilds/${guildId}/members`, {
          limit: MEMBER_PAGE_SIZE,
          ...(after === undefined ? {} : { after }),
        });

        for (const member of batch) {
          if (!member.user) continue;
          snapshots.push(snapshotOf(member, positions, guild.owner_id));
        }

        if (batch.length < MEMBER_PAGE_SIZE) return snapshots;

        // La paginazione va per ID crescente: l'ultimo dell'ultima pagina.
        const last = batch.at(-1)?.user?.id;
        if (last === undefined || last === after) return snapshots;
        after = last;
      }

      log.warn(
        { pages: MAX_MEMBER_PAGES, members: snapshots.length },
        'Enumerazione membri interrotta al tetto di pagine',
      );
      return snapshots;
    },

    async listMembersWithAnyRole(roleIds): Promise<GuildMemberSnapshot[]> {
      const wanted = new Set(roleIds);
      const members = await gateway.listMembers();
      return members.filter((member) => [...wanted].some((id) => member.roleIds.has(id)));
    },

    // ----------------------------------------------------------------- ruoli
    /**
     * Il controllo sincrono della V1 non e' replicabile via REST: qui si
     * risponde `true` e la verifica reale avviene in `applyRoleDiff`, che e'
     * l'unico punto in cui i ruoli cambiano davvero. Nessuna decisione di
     * dominio dipende da questo metodo.
     */
    canManageRole(): boolean {
      return true;
    },

    canManageRoleAsync,

    /**
     * Un solo `PATCH` con l'insieme finale dei ruoli: niente stati intermedi
     * in cui il membro ha zero rank o due, e un solo rate limit consumato.
     * E' la traduzione REST di `member.roles.set()` della V1.
     */
    async applyRoleDiff(discordId, diff, reason): Promise<GuildMemberSnapshot> {
      const member = await fetchMember(discordId);
      if (!member) {
        throw new AppError(
          ERROR_CODE.TARGET_LEFT_GUILD,
          'Questo utente non è più presente nel server Discord.',
        );
      }

      const current = new Set(member.roles);
      const add = diff.add ?? [];
      const remove = diff.remove ?? [];

      // Solo i ruoli che cambiano davvero devono essere gestibili: rimuovere
      // un ruolo che il membro non ha e' un no-op.
      const effective = [...new Set([...add, ...remove])].filter((roleId) => {
        if (add.includes(roleId)) return !current.has(roleId);
        return current.has(roleId);
      });

      if (effective.length > 0) {
        const roles = await getRoles();
        const byId = new Map(roles.map((role) => [role.id, role]));
        const highest = await selfHighestPosition();

        const unmanageable = effective.filter((roleId) => {
          const role = byId.get(roleId);
          return !role || role.managed || role.position >= highest;
        });

        if (unmanageable.length > 0) {
          const names = unmanageable.map((roleId) => byId.get(roleId)?.name ?? roleId).join(', ');
          throw new AppError(
            ERROR_CODE.ROLE_HIERARCHY,
            `Il bot non può gestire questi ruoli: **${names}**.\nSposta il ruolo di TTP Control più in alto nella lista dei ruoli del server.`,
            { context: { unmanageable } },
          );
        }
      }

      const target = new Set(current);
      for (const roleId of remove) target.delete(roleId);
      for (const roleId of add) target.add(roleId);

      // Nessuna differenza: evitiamo una chiamata inutile all'API.
      if (target.size === current.size && [...target].every((id) => current.has(id))) {
        return toSnapshot(member);
      }

      try {
        const updated = await rest.patch<ApiGuildMember>(
          `/guilds/${guildId}/members/${discordId}`,
          { roles: [...target] },
          reason,
        );
        // La risposta della PATCH non include sempre `user`: conserviamo
        // quello gia' noto invece di produrre uno snapshot mutilato.
        const user = updated.user ?? member.user;
        return await toSnapshot(user === undefined ? updated : { ...updated, user });
      } catch (error) {
        log.error({ err: error, discordId, add, remove }, 'Assegnazione ruoli fallita');

        if (
          isDiscordApiError(error) &&
          (error.code === DISCORD_ERROR_CODE.MISSING_PERMISSIONS || error.status === 403)
        ) {
          throw new AppError(
            ERROR_CODE.ROLE_HIERARCHY,
            'Permessi insufficienti per modificare i ruoli di questo utente.\nControlla che il ruolo del bot sia sopra i ruoli che deve gestire.',
            { cause: error },
          );
        }
        throw new AppError(
          ERROR_CODE.ROLE_ASSIGNMENT_FAILED,
          'Non è stato possibile aggiornare i ruoli su Discord.',
          { cause: error, context: { discordId } },
        );
      }
    },

    async addRole(discordId, roleId, reason): Promise<void> {
      await rest.put(`/guilds/${guildId}/members/${discordId}/roles/${roleId}`, undefined, reason);
    },

    async removeRole(discordId, roleId, reason): Promise<void> {
      await rest.request({
        method: 'DELETE',
        path: `/guilds/${guildId}/members/${discordId}/roles/${roleId}`,
        reason,
      });
    },

    async setNickname(discordId, nickname, reason): Promise<void> {
      await rest.patch(`/guilds/${guildId}/members/${discordId}`, { nick: nickname }, reason);
    },

    // -------------------------------------------------------------- messaggi
    async sendMessage(channelId, payload): Promise<string> {
      const message = await sendRaw(channelId, toApiMessage(payload));
      return message.id;
    },

    async editMessage(channelId, messageId, payload): Promise<boolean> {
      try {
        await rest.patch(
          `/channels/${channelId}/messages/${messageId}`,
          toApiMessageForEdit(payload),
        );
        return true;
      } catch (error) {
        // Messaggio o canale spariti: il chiamante decide se ricrearli.
        if (
          isNotFound(error, DISCORD_ERROR_CODE.UNKNOWN_MESSAGE, DISCORD_ERROR_CODE.UNKNOWN_CHANNEL)
        ) {
          return false;
        }
        throw error;
      }
    },

    async getMessage(channelId, messageId): Promise<ApiMessage | null> {
      try {
        return await rest.get<ApiMessage>(`/channels/${channelId}/messages/${messageId}`);
      } catch (error) {
        if (
          isNotFound(error, DISCORD_ERROR_CODE.UNKNOWN_MESSAGE, DISCORD_ERROR_CODE.UNKNOWN_CHANNEL)
        ) {
          return null;
        }
        throw error;
      }
    },

    /** Un DM chiuso non e' un errore: l'operazione a monte resta valida. */
    async sendDM(discordId, payload): Promise<boolean> {
      try {
        const channel = await rest.post<ApiChannel>('/users/@me/channels', {
          recipient_id: discordId,
        });
        await sendRaw(channel.id, toApiMessage(payload));
        return true;
      } catch (error) {
        log.debug({ discordId, err: error }, 'DM non recapitato');
        return false;
      }
    },

    /** Compatibilita' con `RoleGateway`: notifica testuale via DM. */
    async tryNotify(discordId, content): Promise<boolean> {
      return gateway.sendDM(discordId, {
        embeds: [
          {
            title: content.title,
            description: content.description,
            color: EMBED_COLOR.brand,
            timestamp: new Date().toISOString(),
          },
        ],
      });
    },

    // ---------------------------------------------------- pannelli (Panel...)
    /** `PanelMessageGateway.edit` */
    edit(channelId, messageId, payload): Promise<boolean> {
      return gateway.editMessage(channelId, messageId, payload);
    },

    /** `PanelMessageGateway.send` */
    send(channelId, payload): Promise<string> {
      return gateway.sendMessage(channelId, payload);
    },

    // ------------------------------------------------------------ moderazione
    async kick(discordId, reason): Promise<boolean> {
      try {
        await rest.request({
          method: 'DELETE',
          path: `/guilds/${guildId}/members/${discordId}`,
          reason,
        });
        return true;
      } catch (error) {
        log.error({ err: error, discordId }, 'Kick fallito');
        return false;
      }
    },

    async ban(discordId, reason): Promise<boolean> {
      try {
        await rest.put(`/guilds/${guildId}/bans/${discordId}`, {}, reason);
        return true;
      } catch (error) {
        log.error({ err: error, discordId }, 'Ban fallito');
        return false;
      }
    },

    // -------------------------------------------------------------- permessi
    selfGuildPermissions,
    selfChannelPermissions,
  };

  return gateway;
}
