/**
 * Blacklist.
 *
 * L'autorita' e' il DATABASE, non il ruolo Discord `⛔ Banned`: un utente che
 * esce e rientra, o a cui viene tolto il ruolo a mano, resta blacklistato.
 *
 * Nessuna azione distruttiva automatica: kick e ban avvengono solo se la
 * policy della guild li abilita esplicitamente.
 */
import { AuditAction, MemberStatus } from '../generated/prisma/enums.js';
import { AppError, ERROR_CODE } from '../errors/AppError.js';
import type { BlacklistEntry, GuildConfig, Repositories } from '../repositories/types.js';
import { lockKey, memberMutex } from '../utils/mutex.js';
import { createLogger } from '../utils/logger.js';
import type { AuditService } from './auditService.js';
import type { RoleService } from './roleService.js';
import type { RoleGateway } from './roleGateway.js';

const log = createLogger('blacklist');

/** Azioni distruttive opzionali, delegate al layer Discord. */
export interface ModerationGateway {
  kick(discordId: string, reason: string): Promise<boolean>;
  ban(discordId: string, reason: string): Promise<boolean>;
}

export interface BlacklistAddInput {
  readonly discordId: string;
  readonly reason: string;
  readonly actorDiscordId: string;
  readonly rpName?: string | null;
  readonly rpSurname?: string | null;
  readonly notes?: string | null;
}

export interface BlacklistAddOutcome {
  readonly entry: BlacklistEntry;
  /** `true` se era gia' blacklistato: l'operazione non ha cambiato nulla. */
  readonly alreadyBlacklisted: boolean;
  /** Verified rimosso come conseguenza. */
  readonly verifiedRevoked: boolean;
  /** Il target era un membro TTP: la Leadership deve saperlo. */
  readonly wasTtpMember: boolean;
  readonly kicked: boolean;
  readonly banned: boolean;
}

export interface BlacklistService {
  add(input: BlacklistAddInput): Promise<BlacklistAddOutcome>;
  remove(input: {
    discordId: string;
    actorDiscordId: string;
    reason?: string | undefined;
  }): Promise<void>;
  isBlacklisted(discordId: string): Promise<boolean>;
  findActive(discordId: string): Promise<BlacklistEntry | null>;
  history(discordId: string): Promise<BlacklistEntry[]>;
  listActive(options?: { skip?: number; take?: number }): Promise<BlacklistEntry[]>;
  countActive(): Promise<number>;
  /**
   * Applica la policy quando un utente in blacklist rientra nel Discord.
   * Chiamata da `guildMemberAdd`.
   */
  handleRejoin(discordId: string, username: string): Promise<BlacklistEntry | null>;
}

export function createBlacklistService(deps: {
  repos: Repositories;
  roles: RoleService;
  gateway: RoleGateway;
  audit: AuditService;
  moderation?: ModerationGateway | undefined;
  guildId: string;
}): BlacklistService {
  const { repos, roles, gateway, audit, moderation, guildId } = deps;

  async function policy(): Promise<GuildConfig> {
    return repos.guildConfig.ensure(guildId);
  }

  return {
    async add(input: BlacklistAddInput): Promise<BlacklistAddOutcome> {
      return memberMutex.run(lockKey('blacklist', input.discordId), async () => {
        const config = await policy();

        // Idempotenza: `add` restituisce null se c'e' gia' una entry attiva.
        const created = await repos.blacklist.add({
          discordId: input.discordId,
          reason: input.reason,
          createdByDiscordId: input.actorDiscordId,
          rpName: input.rpName ?? null,
          rpSurname: input.rpSurname ?? null,
          notes: input.notes ?? null,
        });

        if (!created) {
          const existing = await repos.blacklist.findActive(input.discordId);
          if (!existing) {
            // Rimossa tra le due query: rarissimo, ma va detto invece di
            // restituire uno stato inventato.
            throw new AppError(
              ERROR_CODE.STATE_CHANGED,
              'Lo stato della blacklist è cambiato durante l’operazione. Riprova.',
            );
          }
          return {
            entry: existing,
            alreadyBlacklisted: true,
            verifiedRevoked: false,
            wasTtpMember: false,
            kicked: false,
            banned: false,
          };
        }

        // --- Conseguenze sull'accesso -----------------------------------
        const member = await repos.members.findByDiscordId(input.discordId);
        const wasTtpMember =
          member !== null &&
          (member.status === MemberStatus.ACTIVE || member.status === MemberStatus.INACTIVE);

        let verifiedRevoked = false;
        const snapshot = await gateway.fetchMember(input.discordId);

        if (snapshot) {
          // La verifica viene revocata: un blacklistato non deve conservare
          // l'accesso alle aree community.
          if (roles.isVerified(snapshot)) {
            await roles.revokeCommunityAccess(input.discordId, `Blacklist: ${input.reason}`);
            verifiedRevoked = true;
          }
          await repos.verifications.revoke(input.discordId, input.actorDiscordId, input.reason);
          await repos.profiles.setVerifiedAt(input.discordId, null);
        }

        // --- Azioni distruttive: SOLO se la policy le abilita -------------
        let kicked = false;
        let banned = false;

        if (config.blacklistAutoBan && moderation) {
          banned = await moderation.ban(input.discordId, `Blacklist TTP: ${input.reason}`);
          if (banned) {
            await audit.record({
              action: AuditAction.BANNED,
              actorDiscordId: input.actorDiscordId,
              targetDiscordId: input.discordId,
              reason: input.reason,
            });
          }
        } else if (config.blacklistAutoKick && moderation) {
          kicked = await moderation.kick(input.discordId, `Blacklist TTP: ${input.reason}`);
          if (kicked) {
            await audit.record({
              action: AuditAction.KICKED,
              actorDiscordId: input.actorDiscordId,
              targetDiscordId: input.discordId,
              reason: input.reason,
            });
          }
        }

        await audit.record(
          {
            action: AuditAction.BLACKLISTED,
            actorDiscordId: input.actorDiscordId,
            targetDiscordId: input.discordId,
            entityType: 'BlacklistEntry',
            entityId: created.id,
            reason: input.reason,
            metadata: { verifiedRevoked, wasTtpMember, kicked, banned },
          },
          ['audit', 'blacklist'],
        );

        return {
          entry: created,
          alreadyBlacklisted: false,
          verifiedRevoked,
          wasTtpMember,
          kicked,
          banned,
        };
      });
    },

    async remove(input): Promise<void> {
      await memberMutex.run(lockKey('blacklist', input.discordId), async () => {
        const active = await repos.blacklist.findActive(input.discordId);
        const removed = await repos.blacklist.remove(
          input.discordId,
          input.actorDiscordId,
          input.reason,
        );

        if (!removed || !active) {
          throw new AppError(
            ERROR_CODE.NOT_BLACKLISTED,
            'Questo utente non è attualmente in blacklist.',
          );
        }

        await audit.record(
          {
            action: AuditAction.UNBLACKLISTED,
            actorDiscordId: input.actorDiscordId,
            targetDiscordId: input.discordId,
            entityType: 'BlacklistEntry',
            entityId: active.id,
            reason: input.reason ?? null,
          },
          ['audit', 'blacklist'],
        );
      });
    },

    isBlacklisted: (discordId) => repos.blacklist.isBlacklisted(discordId),
    findActive: (discordId) => repos.blacklist.findActive(discordId),
    history: (discordId) => repos.blacklist.history(discordId),
    listActive: (options) => repos.blacklist.listActive(options),
    countActive: () => repos.blacklist.countActive(),

    /**
     * Rientro di un utente blacklistato.
     * Di default: nessuna azione distruttiva, solo audit e allerta.
     */
    async handleRejoin(discordId: string, username: string): Promise<BlacklistEntry | null> {
      const entry = await repos.blacklist.findActive(discordId);
      if (!entry) return null;

      const config = await policy();

      await audit.record(
        {
          action: AuditAction.BLACKLISTED_USER_REJOINED,
          targetDiscordId: discordId,
          entityType: 'BlacklistEntry',
          entityId: entry.id,
          reason: entry.reason,
          metadata: { username, originalReason: entry.reason },
        },
        ['audit', 'blacklist'],
      );

      if (config.blacklistAutoBan && moderation) {
        const banned = await moderation.ban(discordId, `Blacklist TTP: ${entry.reason}`);
        log.warn({ discordId, banned }, 'Policy auto-ban applicata al rientro');
      } else if (config.blacklistAutoKick && moderation) {
        const kicked = await moderation.kick(discordId, `Blacklist TTP: ${entry.reason}`);
        log.warn({ discordId, kicked }, 'Policy auto-kick applicata al rientro');
      }

      return entry;
    },
  };
}
