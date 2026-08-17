/**
 * Implementazione Discord di `RoleGateway`, `ModerationGateway` e delle
 * funzioni di enumerazione dei membri.
 *
 * E' l'unico file del progetto che chiama `member.roles.set()`.
 */
import { DiscordAPIError, type Guild, type GuildMember, RESTJSONErrorCodes } from 'discord.js';
import { AppError, ERROR_CODE } from '../errors/AppError.js';
import { EMBED_COLOR } from '../config/constants.js';
import { createLogger } from '../utils/logger.js';
import type { ModerationGateway } from '../services/blacklistService.js';
import type { GuildMemberSnapshot, RoleGateway } from '../services/roleGateway.js';

const log = createLogger('role-gateway');

export function toSnapshot(member: GuildMember): GuildMemberSnapshot {
  return {
    discordId: member.id,
    username: member.user.username,
    displayName: member.displayName,
    roleIds: new Set(member.roles.cache.keys()),
    highestRolePosition: member.roles.highest.position,
    isGuildOwner: member.id === member.guild.ownerId,
  };
}

/** L'errore Discord indica che il membro non esiste (piu'). */
function isUnknownMember(error: unknown): boolean {
  return (
    error instanceof DiscordAPIError &&
    (error.code === RESTJSONErrorCodes.UnknownMember ||
      error.code === RESTJSONErrorCodes.UnknownUser)
  );
}

export function createDiscordRoleGateway(deps: { guild: Guild }): RoleGateway {
  const { guild } = deps;

  async function fetch(discordId: string): Promise<GuildMember | null> {
    try {
      return await guild.members.fetch(discordId);
    } catch (error) {
      if (isUnknownMember(error)) return null;
      throw error;
    }
  }

  function canManage(roleId: string): boolean {
    const role = guild.roles.cache.get(roleId);
    if (!role) return false;
    const me = guild.members.me;
    if (!me) return false;
    // Discord non consente di gestire ruoli con posizione >= alla propria,
    // ne' i ruoli "managed" (creati da integrazioni).
    return !role.managed && me.roles.highest.comparePositionTo(role) > 0;
  }

  return {
    async fetchMember(discordId: string): Promise<GuildMemberSnapshot | null> {
      const member = await fetch(discordId);
      return member ? toSnapshot(member) : null;
    },

    canManageRole: canManage,

    /**
     * Un solo `roles.set()` con l'insieme finale: niente stati intermedi in
     * cui il membro ha zero rank o due, e una sola richiesta all'API.
     */
    async applyRoleDiff(discordId, diff, reason): Promise<GuildMemberSnapshot> {
      const member = await fetch(discordId);
      if (!member) {
        throw new AppError(
          ERROR_CODE.TARGET_LEFT_GUILD,
          'Questo utente non è più presente nel server Discord.',
        );
      }

      const add = diff.add ?? [];
      const remove = diff.remove ?? [];

      // Prima di toccare qualsiasi cosa: il bot può davvero gestire questi
      // ruoli? Meglio un errore chiaro che una modifica a metà.
      const unmanageable = [...new Set([...add, ...remove])]
        .filter((roleId) => {
          // Rimuovere un ruolo che il membro non ha è un no-op: non serve
          // pretendere di poterlo gestire.
          if (!add.includes(roleId) && !member.roles.cache.has(roleId)) return false;
          if (add.includes(roleId) && member.roles.cache.has(roleId)) return false;
          return true;
        })
        .filter((roleId) => !canManage(roleId));

      if (unmanageable.length > 0) {
        const names = unmanageable
          .map((roleId) => guild.roles.cache.get(roleId)?.name ?? roleId)
          .join(', ');
        throw new AppError(
          ERROR_CODE.ROLE_HIERARCHY,
          `Il bot non può gestire questi ruoli: **${names}**.\nSposta il ruolo di TTP Control più in alto nella lista dei ruoli del server.`,
          { context: { unmanageable } },
        );
      }

      const target = new Set(member.roles.cache.keys());
      for (const roleId of remove) target.delete(roleId);
      for (const roleId of add) target.add(roleId);

      // Nessuna differenza: evitiamo una chiamata inutile all'API.
      const current = new Set(member.roles.cache.keys());
      if (target.size === current.size && [...target].every((id) => current.has(id))) {
        return toSnapshot(member);
      }

      try {
        const updated = await member.roles.set([...target], reason);
        return toSnapshot(updated);
      } catch (error) {
        log.error({ err: error, discordId, add, remove }, 'Assegnazione ruoli fallita');
        if (
          error instanceof DiscordAPIError &&
          error.code === RESTJSONErrorCodes.MissingPermissions
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

    /** Un DM chiuso non è un errore: l'operazione resta valida. */
    async tryNotify(discordId, content): Promise<boolean> {
      try {
        const member = await fetch(discordId);
        if (!member) return false;
        await member.send({
          embeds: [
            {
              title: content.title,
              description: content.description,
              color: EMBED_COLOR.brand,
              timestamp: new Date().toISOString(),
            },
          ],
        });
        return true;
      } catch (error) {
        log.debug({ discordId, err: error }, 'DM non recapitato');
        return false;
      }
    },
  };
}

export function createDiscordModerationGateway(guild: Guild): ModerationGateway {
  return {
    async kick(discordId: string, reason: string): Promise<boolean> {
      try {
        const member = await guild.members.fetch(discordId);
        await member.kick(reason);
        return true;
      } catch (error) {
        log.error({ err: error, discordId }, 'Kick fallito');
        return false;
      }
    },

    async ban(discordId: string, reason: string): Promise<boolean> {
      try {
        await guild.bans.create(discordId, { reason });
        return true;
      } catch (error) {
        log.error({ err: error, discordId }, 'Ban fallito');
        return false;
      }
    },
  };
}

/**
 * Enumerazione dei membri della guild.
 * Richiede l'intent privilegiato `GuildMembers`.
 */
export function createMemberEnumerator(guild: Guild) {
  return {
    async all(): Promise<GuildMemberSnapshot[]> {
      const members = await guild.members.fetch();
      return members.map(toSnapshot);
    },

    async withAnyRole(roleIds: readonly string[]): Promise<GuildMemberSnapshot[]> {
      const wanted = new Set(roleIds);
      const members = await guild.members.fetch();
      return members.filter((m) => [...wanted].some((id) => m.roles.cache.has(id))).map(toSnapshot);
    },
  };
}
