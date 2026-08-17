/**
 * Implementazioni in memoria dei repository.
 *
 * Permettono di testare la business logic reale — gli stessi service che
 * girano in produzione — senza database né Discord. Riproducono anche i
 * vincoli che in produzione garantisce PostgreSQL (unique sulle sentinelle,
 * locking ottimistico su `Member.version`), perché sono proprio quelli a
 * reggere i casi di concorrenza.
 */
import {
  MemberStatus,
  TtpApplicationStatus,
  type MemberRank,
  type PanelType,
  type SpecialRole,
} from '../../src/generated/prisma/enums.js';
import { RANK_ORDER } from '../../src/config/constants.js';
import type {
  AuditLog,
  BlacklistEntry,
  DiscordProfile,
  GuildConfig,
  GuildMemberSnapshotRow,
  Member,
  MemberHistory,
  MemberSpecialRole,
  PersistentPanel,
  Repositories,
  TtpApplication,
  Verification,
} from '../../src/repositories/types.js';

let sequence = 0;
function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}_${sequence}`;
}

export interface InMemoryStore {
  profiles: Map<string, DiscordProfile>;
  verifications: Map<string, Verification>;
  applications: Map<string, TtpApplication>;
  members: Map<string, Member>;
  history: MemberHistory[];
  specialRoles: Map<string, MemberSpecialRole>;
  blacklist: Map<string, BlacklistEntry>;
  audit: AuditLog[];
  guildConfig: Map<string, GuildConfig>;
  panels: Map<string, PersistentPanel>;
  /** Chiave: `guildId:discordId`. */
  snapshots: Map<string, GuildMemberSnapshotRow & { leftAt: Date | null; seenAt: Date }>;
}

export function createStore(): InMemoryStore {
  return {
    profiles: new Map(),
    verifications: new Map(),
    applications: new Map(),
    members: new Map(),
    history: [],
    specialRoles: new Map(),
    blacklist: new Map(),
    audit: [],
    guildConfig: new Map(),
    panels: new Map(),
    snapshots: new Map(),
  };
}

const DEFAULT_GUILD_CONFIG: Omit<GuildConfig, 'guildId' | 'createdAt' | 'updatedAt'> = {
  bigCanManageBig: false,
  bigCanPromoteToLeadership: false,
  bigCanBlacklist: true,
  bigCanUseControlPanel: true,
  youngOgCanReviewApplications: false,
  blacklistAutoKick: false,
  blacklistAutoBan: false,
  removeSpecialRolesOnLeave: true,
  removeCommunityRolesOnJoin: false,
};

export function createInMemoryRepositories(store: InMemoryStore): Repositories {
  const now = (): Date => new Date();

  return {
    profiles: {
      async upsert(identity): Promise<DiscordProfile> {
        const existing = store.profiles.get(identity.discordId);
        const profile: DiscordProfile = {
          discordId: identity.discordId,
          username: identity.username,
          displayName: identity.displayName ?? null,
          firstSeenAt: existing?.firstSeenAt ?? now(),
          lastSeenAt: now(),
          verifiedAt: existing?.verifiedAt ?? null,
          createdAt: existing?.createdAt ?? now(),
          updatedAt: now(),
        };
        store.profiles.set(identity.discordId, profile);
        return profile;
      },
      async findByDiscordId(discordId): Promise<DiscordProfile | null> {
        return store.profiles.get(discordId) ?? null;
      },
      async setVerifiedAt(discordId, verifiedAt): Promise<void> {
        const profile = store.profiles.get(discordId);
        if (profile) store.profiles.set(discordId, { ...profile, verifiedAt });
      },
      async countVerified(): Promise<number> {
        return [...store.profiles.values()].filter((p) => p.verifiedAt !== null).length;
      },
      async listVerified(): Promise<DiscordProfile[]> {
        return [...store.profiles.values()].filter((p) => p.verifiedAt !== null);
      },
    },

    verifications: {
      async create(input): Promise<Verification> {
        const existing = store.verifications.get(input.discordId);
        const record: Verification = {
          id: existing?.id ?? nextId('ver'),
          discordId: input.discordId,
          rpName: input.rpName,
          oocName: input.oocName,
          rpSurname: null,
          citizenId: null,
          phone: null,
          referral: null,
          verifiedAt: now(),
          revokedAt: null,
          revokedByDiscordId: null,
          revokeReason: null,
          createdAt: existing?.createdAt ?? now(),
          updatedAt: now(),
        };
        store.verifications.set(input.discordId, record);
        return record;
      },
      async findByDiscordId(discordId): Promise<Verification | null> {
        return store.verifications.get(discordId) ?? null;
      },
      async findActive(discordId): Promise<Verification | null> {
        const record = store.verifications.get(discordId);
        return record?.revokedAt === null ? record : null;
      },
      async revoke(discordId, revokedByDiscordId, reason): Promise<void> {
        const record = store.verifications.get(discordId);
        if (record?.revokedAt !== null) return;
        store.verifications.set(discordId, {
          ...record,
          revokedAt: now(),
          revokedByDiscordId,
          revokeReason: reason ?? null,
        });
      },
      async countActive(): Promise<number> {
        return [...store.verifications.values()].filter((v) => v.revokedAt === null).length;
      },
    },

    applications: {
      async createPending(input): Promise<TtpApplication> {
        // Riproduce il vincolo `pendingForDiscordId @unique`.
        const duplicate = [...store.applications.values()].find(
          (app) => app.pendingForDiscordId === input.discordId,
        );
        if (duplicate) {
          throw new Error('Unique constraint failed on pendingForDiscordId');
        }

        const record: TtpApplication = {
          id: nextId('app'),
          discordId: input.discordId,
          status: TtpApplicationStatus.PENDING,
          pendingForDiscordId: input.discordId,
          requestedAt: now(),
          reviewedAt: null,
          reviewedByDiscordId: null,
          rejectionReason: null,
          initialRank: null,
          notes: input.notes ?? null,
          channelId: null,
          messageId: null,
          createdAt: now(),
          updatedAt: now(),
        };
        store.applications.set(record.id, record);
        return record;
      },
      async findById(id): Promise<TtpApplication | null> {
        return store.applications.get(id) ?? null;
      },
      async findPendingByDiscordId(discordId): Promise<TtpApplication | null> {
        return (
          [...store.applications.values()].find((app) => app.pendingForDiscordId === discordId) ??
          null
        );
      },
      async listByDiscordId(discordId): Promise<TtpApplication[]> {
        return [...store.applications.values()].filter((app) => app.discordId === discordId);
      },
      async listPending(): Promise<TtpApplication[]> {
        return [...store.applications.values()].filter(
          (app) => app.status === TtpApplicationStatus.PENDING,
        );
      },
      async countPending(): Promise<number> {
        return [...store.applications.values()].filter(
          (app) => app.status === TtpApplicationStatus.PENDING,
        ).length;
      },
      async attachMessage(id, channelId, messageId): Promise<void> {
        const record = store.applications.get(id);
        if (record) store.applications.set(id, { ...record, channelId, messageId });
      },
      async resolve(id, input): Promise<TtpApplication | null> {
        const record = store.applications.get(id);
        // Transizione condizionata: solo da PENDING.
        if (record?.status !== TtpApplicationStatus.PENDING) return null;

        const updated: TtpApplication = {
          ...record,
          status: input.status,
          pendingForDiscordId: null,
          reviewedAt: now(),
          reviewedByDiscordId: input.reviewedByDiscordId,
          rejectionReason: input.rejectionReason ?? null,
          initialRank: input.initialRank ?? null,
          updatedAt: now(),
        };
        store.applications.set(id, updated);
        return updated;
      },
      async revertToPending(id): Promise<TtpApplication | null> {
        const record = store.applications.get(id);
        if (record === undefined || record.status === TtpApplicationStatus.PENDING) return null;

        // Riproduce il vincolo unique: se esiste gia' un'altra PENDING per lo
        // stesso utente, il rollback non e' possibile.
        const conflicting = [...store.applications.values()].find(
          (app) => app.pendingForDiscordId === record.discordId,
        );
        if (conflicting) return null;

        const reverted: TtpApplication = {
          ...record,
          status: TtpApplicationStatus.PENDING,
          pendingForDiscordId: record.discordId,
          reviewedAt: null,
          reviewedByDiscordId: null,
          rejectionReason: null,
          updatedAt: now(),
        };
        store.applications.set(id, reverted);
        return reverted;
      },
    },

    members: {
      async findByDiscordId(discordId): Promise<Member | null> {
        return [...store.members.values()].find((m) => m.discordId === discordId) ?? null;
      },
      async findById(id): Promise<Member | null> {
        return store.members.get(id) ?? null;
      },
      async create(input): Promise<Member> {
        const record: Member = {
          id: nextId('mem'),
          discordId: input.discordId,
          rpName: input.rpName ?? null,
          rpSurname: input.rpSurname ?? null,
          citizenId: input.citizenId ?? null,
          phone: input.phone ?? null,
          rank: input.rank,
          status: MemberStatus.ACTIVE,
          joinedTtpAt: now(),
          leftTtpAt: null,
          recruitedByDiscordId: input.recruitedByDiscordId ?? null,
          notes: input.notes ?? null,
          version: 0,
          createdAt: now(),
          updatedAt: now(),
        };
        store.members.set(record.id, record);
        return record;
      },
      async list(filter): Promise<Member[]> {
        return [...store.members.values()].filter((member) => {
          if (filter?.rank !== undefined && member.rank !== filter.rank) return false;
          if (filter?.status !== undefined && member.status !== filter.status) return false;
          if (filter?.statusIn !== undefined && !filter.statusIn.includes(member.status)) {
            return false;
          }
          return true;
        });
      },
      async counts() {
        const all = [...store.members.values()];
        const byStatus = (status: MemberStatus): number =>
          all.filter((m) => m.status === status).length;
        // Partial: non tutti i rank sono necessariamente rappresentati.
        const byRank: Partial<Record<MemberRank, number>> = {};
        for (const member of all) {
          if (member.status === MemberStatus.ACTIVE || member.status === MemberStatus.INACTIVE) {
            byRank[member.rank] = (byRank[member.rank] ?? 0) + 1;
          }
        }
        return {
          total: byStatus(MemberStatus.ACTIVE) + byStatus(MemberStatus.INACTIVE),
          active: byStatus(MemberStatus.ACTIVE),
          inactive: byStatus(MemberStatus.INACTIVE),
          permadeath: byStatus(MemberStatus.PERMADEATH),
          left: byStatus(MemberStatus.LEFT),
          // Derivato da RANK_ORDER invece che elencato a mano: la gerarchia
          // ha una sola definizione autorevole, e questa fixture la segue.
          byRank: Object.fromEntries(RANK_ORDER.map((rank) => [rank, byRank[rank] ?? 0])) as Record<
            MemberRank,
            number
          >,
        };
      },
      async countByStatus(status): Promise<number> {
        return [...store.members.values()].filter((m) => m.status === status).length;
      },
      /** Locking ottimistico: identico al `WHERE version = ?` di produzione. */
      async updateWithVersion(id, expectedVersion, patch): Promise<Member | null> {
        const record = store.members.get(id);
        if (record?.version !== expectedVersion) return null;

        const updated: Member = {
          ...record,
          ...(patch.rank === undefined ? {} : { rank: patch.rank }),
          ...(patch.status === undefined ? {} : { status: patch.status }),
          ...(patch.leftTtpAt === undefined ? {} : { leftTtpAt: patch.leftTtpAt }),
          ...(patch.joinedTtpAt === undefined ? {} : { joinedTtpAt: patch.joinedTtpAt }),
          ...(patch.notes === undefined ? {} : { notes: patch.notes }),
          ...(patch.recruitedByDiscordId === undefined
            ? {}
            : { recruitedByDiscordId: patch.recruitedByDiscordId }),
          ...(patch.rpName === undefined ? {} : { rpName: patch.rpName }),
          ...(patch.rpSurname === undefined ? {} : { rpSurname: patch.rpSurname }),
          ...(patch.citizenId === undefined ? {} : { citizenId: patch.citizenId }),
          ...(patch.phone === undefined ? {} : { phone: patch.phone }),
          version: record.version + 1,
          updatedAt: now(),
        };
        store.members.set(id, updated);
        return updated;
      },
      async setNotes(id, notes): Promise<Member> {
        const record = store.members.get(id);
        if (!record) throw new Error(`Member ${id} inesistente`);
        const updated = { ...record, notes, updatedAt: now() };
        store.members.set(id, updated);
        return updated;
      },
    },

    history: {
      async record(input): Promise<MemberHistory> {
        const record: MemberHistory = {
          id: nextId('hist'),
          memberId: input.memberId,
          discordId: input.discordId,
          event: input.event,
          fromRank: input.fromRank ?? null,
          toRank: input.toRank ?? null,
          fromStatus: input.fromStatus ?? null,
          toStatus: input.toStatus ?? null,
          specialRole: input.specialRole ?? null,
          actorDiscordId: input.actorDiscordId ?? null,
          reason: input.reason ?? null,
          createdAt: now(),
        };
        store.history.push(record);
        return record;
      },
      async listForMember(memberId, limit = 25): Promise<MemberHistory[]> {
        return store.history
          .filter((h) => h.memberId === memberId)
          .slice(-limit)
          .reverse();
      },
    },

    specialRoles: {
      async listActive(memberId): Promise<MemberSpecialRole[]> {
        return [...store.specialRoles.values()].filter(
          (entry) => entry.memberId === memberId && entry.removedAt === null,
        );
      },
      async add(memberId, role, actorDiscordId): Promise<MemberSpecialRole | null> {
        const key = `${memberId}:${role}`;
        const existing = [...store.specialRoles.values()].find((e) => e.activeKey === key);
        if (existing) return null;

        const record: MemberSpecialRole = {
          id: nextId('spec'),
          memberId,
          role,
          activeKey: key,
          assignedAt: now(),
          assignedByDiscordId: actorDiscordId,
          removedAt: null,
          removedByDiscordId: null,
          createdAt: now(),
          updatedAt: now(),
        };
        store.specialRoles.set(record.id, record);
        return record;
      },
      async remove(memberId, role, actorDiscordId): Promise<boolean> {
        const key = `${memberId}:${role}`;
        const existing = [...store.specialRoles.values()].find((e) => e.activeKey === key);
        if (!existing) return false;
        store.specialRoles.set(existing.id, {
          ...existing,
          activeKey: null,
          removedAt: now(),
          removedByDiscordId: actorDiscordId,
        });
        return true;
      },
      async removeAll(memberId, actorDiscordId): Promise<SpecialRole[]> {
        const active = [...store.specialRoles.values()].filter(
          (entry) => entry.memberId === memberId && entry.removedAt === null,
        );
        for (const entry of active) {
          store.specialRoles.set(entry.id, {
            ...entry,
            activeKey: null,
            removedAt: now(),
            removedByDiscordId: actorDiscordId,
          });
        }
        return active.map((entry) => entry.role);
      },
    },

    blacklist: {
      async add(input): Promise<BlacklistEntry | null> {
        const existing = [...store.blacklist.values()].find(
          (entry) => entry.activeKey === input.discordId,
        );
        if (existing) return null;

        const record: BlacklistEntry = {
          id: nextId('bl'),
          discordId: input.discordId,
          rpName: input.rpName ?? null,
          rpSurname: input.rpSurname ?? null,
          reason: input.reason,
          notes: input.notes ?? null,
          active: true,
          activeKey: input.discordId,
          createdByDiscordId: input.createdByDiscordId,
          createdAt: now(),
          removedByDiscordId: null,
          removedAt: null,
          removeReason: null,
          updatedAt: now(),
        };
        store.blacklist.set(record.id, record);
        return record;
      },
      async findActive(discordId): Promise<BlacklistEntry | null> {
        return [...store.blacklist.values()].find((entry) => entry.activeKey === discordId) ?? null;
      },
      async isBlacklisted(discordId): Promise<boolean> {
        return [...store.blacklist.values()].some((entry) => entry.activeKey === discordId);
      },
      async remove(discordId, removedByDiscordId, reason): Promise<boolean> {
        const existing = [...store.blacklist.values()].find(
          (entry) => entry.activeKey === discordId,
        );
        if (!existing) return false;
        store.blacklist.set(existing.id, {
          ...existing,
          active: false,
          activeKey: null,
          removedAt: now(),
          removedByDiscordId,
          removeReason: reason ?? null,
        });
        return true;
      },
      async listActive(): Promise<BlacklistEntry[]> {
        return [...store.blacklist.values()].filter((entry) => entry.active);
      },
      async countActive(): Promise<number> {
        return [...store.blacklist.values()].filter((entry) => entry.active).length;
      },
      async history(discordId): Promise<BlacklistEntry[]> {
        return [...store.blacklist.values()].filter((entry) => entry.discordId === discordId);
      },
    },

    audit: {
      async record(input): Promise<AuditLog> {
        const record: AuditLog = {
          id: nextId('audit'),
          action: input.action,
          actorDiscordId: input.actorDiscordId ?? null,
          targetDiscordId: input.targetDiscordId ?? null,
          entityType: input.entityType ?? null,
          entityId: input.entityId ?? null,
          previousValue: input.previousValue ?? null,
          newValue: input.newValue ?? null,
          reason: input.reason ?? null,
          metadata: input.metadata ?? null,
          createdAt: now(),
        };
        store.audit.push(record);
        return record;
      },
      async listRecent(limit = 25): Promise<AuditLog[]> {
        return store.audit.slice(-limit).reverse();
      },
      async listForTarget(discordId, limit = 25): Promise<AuditLog[]> {
        return store.audit
          .filter((entry) => entry.targetDiscordId === discordId)
          .slice(-limit)
          .reverse();
      },
    },

    guildConfig: {
      async ensure(guildId): Promise<GuildConfig> {
        const existing = store.guildConfig.get(guildId);
        if (existing) return existing;
        const config: GuildConfig = {
          guildId,
          ...DEFAULT_GUILD_CONFIG,
          createdAt: now(),
          updatedAt: now(),
        };
        store.guildConfig.set(guildId, config);
        return config;
      },
      async update(guildId, patch): Promise<GuildConfig> {
        const existing = store.guildConfig.get(guildId) ?? {
          guildId,
          ...DEFAULT_GUILD_CONFIG,
          createdAt: now(),
          updatedAt: now(),
        };
        const updated = { ...existing, ...patch, updatedAt: now() };
        store.guildConfig.set(guildId, updated);
        return updated;
      },
    },

    snapshots: {
      async listForGuild(guildId): Promise<GuildMemberSnapshotRow[]> {
        return [...store.snapshots.entries()]
          .filter(([key]) => key.startsWith(`${guildId}:`))
          .map(([, row]) => ({
            discordId: row.discordId,
            inGuild: row.inGuild,
            roleIds: [...row.roleIds],
            rolesHash: row.rolesHash,
            nickname: row.nickname ?? null,
          }));
      },

      async countForGuild(guildId): Promise<number> {
        return [...store.snapshots.keys()].filter((key) => key.startsWith(`${guildId}:`)).length;
      },

      async upsertMany(rows): Promise<void> {
        for (const row of rows) {
          store.snapshots.set(`${row.guildId}:${row.discordId}`, {
            discordId: row.discordId,
            inGuild: row.inGuild,
            roleIds: [...row.roleIds],
            rolesHash: row.rolesHash,
            nickname: row.nickname ?? null,
            leftAt: null,
            seenAt: row.seenAt,
          });
        }
      },

      async markLeft(guildId, discordId, at): Promise<void> {
        const existing = store.snapshots.get(`${guildId}:${discordId}`);
        if (!existing) return;
        store.snapshots.set(`${guildId}:${discordId}`, {
          ...existing,
          inGuild: false,
          leftAt: at,
        });
      },
    },

    panels: {
      async find(guildId, panelType): Promise<PersistentPanel | null> {
        return store.panels.get(`${guildId}:${panelType}`) ?? null;
      },
      async save(input): Promise<PersistentPanel> {
        const key = `${input.guildId}:${input.panelType}`;
        const existing = store.panels.get(key);
        const record: PersistentPanel = {
          id: existing?.id ?? nextId('panel'),
          guildId: input.guildId,
          panelType: input.panelType,
          channelId: input.channelId,
          messageId: input.messageId,
          createdAt: existing?.createdAt ?? now(),
          updatedAt: now(),
        };
        store.panels.set(key, record);
        return record;
      },
      async delete(guildId, panelType: PanelType): Promise<void> {
        store.panels.delete(`${guildId}:${panelType}`);
      },
    },
  };
}
