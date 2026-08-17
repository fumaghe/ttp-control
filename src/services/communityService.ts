/**
 * Community management: chi frequenta STREET/CHILL senza essere TTP.
 *
 * `Verified` puo' esistere benissimo senza `TTP`: e' il caso normale della
 * community. Quello che non deve MAI esistere e' `TTP` senza `Verified`.
 */
import { AuditAction, MemberStatus } from '../generated/prisma/enums.js';
import { AppError, ERROR_CODE } from '../errors/AppError.js';
import type {
  BlacklistEntry,
  DiscordProfile,
  Member,
  Repositories,
  TtpApplication,
  Verification,
} from '../repositories/types.js';
import { lockKey, memberMutex } from '../utils/mutex.js';
import type { AuditService } from './auditService.js';
import type { MemberService } from './memberService.js';
import type { RoleService } from './roleService.js';
import type { GuildMemberSnapshot, RoleGateway } from './roleGateway.js';
import type { VerificationService } from './verificationService.js';

export type CommunityRole = 'friend' | 'mafia';

export interface CommunityProfile {
  readonly discordId: string;
  readonly profile: DiscordProfile | null;
  readonly snapshot: GuildMemberSnapshot | null;
  readonly verification: Verification | null;
  readonly member: Member | null;
  readonly isVerified: boolean;
  readonly isTtp: boolean;
  readonly isFriend: boolean;
  readonly isMafia: boolean;
  readonly blacklist: BlacklistEntry | null;
  readonly blacklistHistory: readonly BlacklistEntry[];
  readonly applications: readonly TtpApplication[];
}

export interface CommunityListEntry {
  readonly discordId: string;
  readonly displayName: string;
  readonly isTtp: boolean;
  readonly isFriend: boolean;
  readonly isMafia: boolean;
  readonly verifiedAt: Date | null;
}

export interface CommunityService {
  /** Dossier completo su un utente. */
  describe(discordId: string): Promise<CommunityProfile>;

  /**
   * Assegna `Verified` manualmente. Valida la blacklist e NON assegna mai TTP.
   */
  grantVerified(input: {
    discordId: string;
    actorDiscordId: string;
    reason?: string | undefined;
  }): Promise<{ alreadyVerified: boolean }>;

  revokeVerified(input: {
    discordId: string;
    actorDiscordId: string;
    reason?: string | undefined;
  }): Promise<void>;

  setCommunityRole(input: {
    discordId: string;
    actorDiscordId: string;
    role: CommunityRole;
    grant: boolean;
    reason?: string | undefined;
  }): Promise<{ changed: boolean }>;

  /**
   * Revoca l'intero accesso community: Verified + Friend + Mafia.
   * Rifiuta se il target e' ancora TTP, per non creare `TTP senza Verified`.
   */
  revokeAccess(input: {
    discordId: string;
    actorDiscordId: string;
    reason: string;
    /** Conferma esplicita richiesta se il target e' ancora TTP. */
    force?: boolean | undefined;
  }): Promise<void>;

  list(filter: {
    kind: 'verified' | 'friend' | 'mafia' | 'all';
    excludeTtp: boolean;
    limit?: number | undefined;
  }): Promise<CommunityListEntry[]>;

  countVerified(): Promise<number>;
}

export function createCommunityService(deps: {
  repos: Repositories;
  roles: RoleService;
  gateway: RoleGateway;
  audit: AuditService;
  verification: VerificationService;
  members: MemberService;
  verifiedRoleId: string;
  friendRoleId: string;
  mafiaRoleId: string;
  /** Elenca gli utenti della guild che possiedono uno di questi ruoli. */
  listGuildMembersWithRoles: (roleIds: readonly string[]) => Promise<GuildMemberSnapshot[]>;
}): CommunityService {
  const { repos, roles, gateway, audit, verification, verifiedRoleId, friendRoleId, mafiaRoleId } =
    deps;

  return {
    async describe(discordId: string): Promise<CommunityProfile> {
      const [profile, snapshot, verif, member, blacklist, blacklistHistory, applications] =
        await Promise.all([
          repos.profiles.findByDiscordId(discordId),
          gateway.fetchMember(discordId),
          repos.verifications.findActive(discordId),
          repos.members.findByDiscordId(discordId),
          repos.blacklist.findActive(discordId),
          repos.blacklist.history(discordId),
          repos.applications.listByDiscordId(discordId),
        ]);

      return {
        discordId,
        profile,
        snapshot,
        verification: verif,
        member,
        isVerified: snapshot ? roles.isVerified(snapshot) : verif !== null,
        isTtp: snapshot ? roles.isTtp(snapshot) : false,
        isFriend: snapshot?.roleIds.has(friendRoleId) ?? false,
        isMafia: snapshot?.roleIds.has(mafiaRoleId) ?? false,
        blacklist,
        blacklistHistory,
        applications,
      };
    },

    async grantVerified(input): Promise<{ alreadyVerified: boolean }> {
      return memberMutex.run(lockKey('verify', input.discordId), async () => {
        const snapshot = await gateway.fetchMember(input.discordId);
        if (!snapshot) {
          throw new AppError(
            ERROR_CODE.TARGET_LEFT_GUILD,
            'Questo utente non è presente nel server Discord.',
          );
        }

        // La blacklist e' autorevole anche per l'assegnazione manuale:
        // nessuna scorciatoia amministrativa la aggira.
        if (await repos.blacklist.isBlacklisted(input.discordId)) {
          throw new AppError(
            ERROR_CODE.BLACKLISTED,
            'Questo utente è in blacklist: rimuovilo dalla blacklist prima di verificarlo.',
          );
        }

        const existing = await repos.verifications.findActive(input.discordId);
        if (existing && roles.isVerified(snapshot)) {
          return { alreadyVerified: true };
        }

        await repos.profiles.upsert({
          discordId: input.discordId,
          username: snapshot.username,
          displayName: snapshot.displayName,
        });

        if (!existing) {
          // Verifica amministrativa: i dati IC non sono stati raccolti da un
          // modal, quindi restano marcati come inseriti dalla Leadership.
          const created = await repos.verifications.create({
            discordId: input.discordId,
            rpName: '—',
            rpSurname: '—',
            citizenId: '—',
            phone: '—',
            referral: `Verifica manuale di <@${input.actorDiscordId}>`,
          });
          await repos.profiles.setVerifiedAt(input.discordId, created.verifiedAt);
        }

        // Solo Verified: mai TTP.
        await roles.assignVerified(input.discordId, input.reason ?? 'Verifica manuale Leadership');

        await audit.record({
          action: AuditAction.USER_VERIFIED,
          actorDiscordId: input.actorDiscordId,
          targetDiscordId: input.discordId,
          reason: input.reason ?? 'Verifica manuale',
          metadata: { manual: true },
        });

        return { alreadyVerified: false };
      });
    },

    async revokeVerified(input): Promise<void> {
      const member = await repos.members.findByDiscordId(input.discordId);
      if (
        member &&
        (member.status === MemberStatus.ACTIVE || member.status === MemberStatus.INACTIVE)
      ) {
        throw new AppError(
          ERROR_CODE.ALREADY_TTP,
          'Questo utente è un membro TTP attivo: rimuoverlo da Verified creerebbe uno stato incoerente (`TTP senza Verified`).\nUsa prima `/member remove`.',
        );
      }

      await verification.revoke({
        discordId: input.discordId,
        actorDiscordId: input.actorDiscordId,
        reason: input.reason,
      });

      const snapshot = await gateway.fetchMember(input.discordId);
      if (snapshot) {
        await roles.removeVerified(input.discordId, input.reason ?? 'Verifica revocata');
      }
    },

    async setCommunityRole(input): Promise<{ changed: boolean }> {
      const snapshot = await gateway.fetchMember(input.discordId);
      if (!snapshot) {
        throw new AppError(
          ERROR_CODE.TARGET_LEFT_GUILD,
          'Questo utente non è presente nel server Discord.',
        );
      }

      const roleId = input.role === 'friend' ? friendRoleId : mafiaRoleId;
      const has = snapshot.roleIds.has(roleId);

      // Idempotente: assegnare due volte non e' un errore.
      if (has === input.grant) return { changed: false };

      if (input.grant) {
        await roles.assignCommunityRole(
          input.discordId,
          input.role,
          input.reason ?? 'Ruolo community assegnato',
        );
      } else {
        await roles.removeCommunityRole(
          input.discordId,
          input.role,
          input.reason ?? 'Ruolo community rimosso',
        );
      }

      await audit.record({
        action: input.grant
          ? AuditAction.COMMUNITY_ROLE_GRANTED
          : AuditAction.COMMUNITY_ROLE_REVOKED,
        actorDiscordId: input.actorDiscordId,
        targetDiscordId: input.discordId,
        newValue: input.role,
        reason: input.reason ?? null,
      });

      return { changed: true };
    },

    async revokeAccess(input): Promise<void> {
      const snapshot = await gateway.fetchMember(input.discordId);
      if (!snapshot) {
        throw new AppError(
          ERROR_CODE.TARGET_LEFT_GUILD,
          'Questo utente non è presente nel server Discord.',
        );
      }

      const member = await repos.members.findByDiscordId(input.discordId);
      const stillTtp =
        roles.isTtp(snapshot) ||
        (member !== null &&
          (member.status === MemberStatus.ACTIVE || member.status === MemberStatus.INACTIVE));

      if (stillTtp && !(input.force ?? false)) {
        throw new AppError(
          ERROR_CODE.ALREADY_TTP,
          'Questo utente è ancora un membro TTP.\nRevocare l’accesso community creerebbe uno stato `TTP senza Verified`.\nUsa prima `/member remove`, oppure conferma esplicitamente.',
        );
      }

      await roles.revokeCommunityAccess(input.discordId, input.reason);
      await repos.verifications.revoke(input.discordId, input.actorDiscordId, input.reason);
      await repos.profiles.setVerifiedAt(input.discordId, null);

      await audit.record({
        action: AuditAction.COMMUNITY_ROLE_REVOKED,
        actorDiscordId: input.actorDiscordId,
        targetDiscordId: input.discordId,
        reason: input.reason,
        metadata: { revoked: ['verified', 'friend', 'mafia'], forced: input.force ?? false },
      });
    },

    async list(filter): Promise<CommunityListEntry[]> {
      const roleIds: string[] = (() => {
        switch (filter.kind) {
          case 'friend':
            return [friendRoleId];
          case 'mafia':
            return [mafiaRoleId];
          case 'verified':
            return [verifiedRoleId];
          case 'all':
            return [verifiedRoleId, friendRoleId, mafiaRoleId];
          default: {
            const exhaustive: never = filter.kind;
            throw new Error(`Filtro community sconosciuto: ${String(exhaustive)}`);
          }
        }
      })();

      const snapshots = await deps.listGuildMembersWithRoles(roleIds);

      const candidates = snapshots.filter(
        (snapshot) => !(filter.excludeTtp && roles.isTtp(snapshot)),
      );

      // Una sola passata sui profili invece di una query per utente.
      const profiles = await Promise.all(
        candidates.map((snapshot) => repos.profiles.findByDiscordId(snapshot.discordId)),
      );

      const entries: CommunityListEntry[] = candidates.map((snapshot, index) => ({
        discordId: snapshot.discordId,
        displayName: snapshot.displayName,
        isTtp: roles.isTtp(snapshot),
        isFriend: snapshot.roleIds.has(friendRoleId),
        isMafia: snapshot.roleIds.has(mafiaRoleId),
        verifiedAt: snapshot.roleIds.has(verifiedRoleId)
          ? (profiles[index]?.verifiedAt ?? null)
          : null,
      }));

      entries.sort((a, b) => a.displayName.localeCompare(b.displayName));
      return filter.limit === undefined ? entries : entries.slice(0, filter.limit);
    },

    countVerified: () => repos.verifications.countActive(),
  };
}
