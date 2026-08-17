import type { Database } from '../../database/prisma.js';
import type { DiscordProfile, DiscordProfileRepository, ProfileIdentity } from '../types.js';

export function createDiscordProfileRepository(db: Database): DiscordProfileRepository {
  return {
    async upsert(identity: ProfileIdentity): Promise<DiscordProfile> {
      const now = new Date();
      return db.discordProfile.upsert({
        where: { discordId: identity.discordId },
        create: {
          discordId: identity.discordId,
          username: identity.username,
          displayName: identity.displayName ?? null,
          firstSeenAt: now,
          lastSeenAt: now,
        },
        update: {
          username: identity.username,
          displayName: identity.displayName ?? null,
          lastSeenAt: now,
        },
      });
    },

    async findByDiscordId(discordId: string): Promise<DiscordProfile | null> {
      return db.discordProfile.findUnique({ where: { discordId } });
    },

    async setVerifiedAt(discordId: string, verifiedAt: Date | null): Promise<void> {
      await db.discordProfile.update({ where: { discordId }, data: { verifiedAt } });
    },

    async countVerified(): Promise<number> {
      return db.discordProfile.count({ where: { verifiedAt: { not: null } } });
    },

    async listVerified(options): Promise<DiscordProfile[]> {
      return db.discordProfile.findMany({
        where: { verifiedAt: { not: null } },
        orderBy: { verifiedAt: 'desc' },
        ...(options?.skip === undefined ? {} : { skip: options.skip }),
        ...(options?.take === undefined ? {} : { take: options.take }),
      });
    },
  };
}
