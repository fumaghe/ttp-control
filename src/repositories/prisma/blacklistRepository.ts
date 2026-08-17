import type { Database } from '../../database/prisma.js';
import type { BlacklistEntry, BlacklistInput, BlacklistRepository } from '../types.js';

export function createBlacklistRepository(db: Database): BlacklistRepository {
  return {
    /**
     * Idempotente: se c'e' gia' una entry attiva restituisce `null`.
     * `activeKey @unique` impedisce comunque due entry attive per lo stesso
     * Discord ID, anche con due operatori simultanei.
     */
    async add(input: BlacklistInput): Promise<BlacklistEntry | null> {
      const existing = await db.blacklistEntry.findUnique({
        where: { activeKey: input.discordId },
      });
      if (existing) return null;

      return db.blacklistEntry.create({
        data: {
          discordId: input.discordId,
          activeKey: input.discordId,
          active: true,
          reason: input.reason,
          createdByDiscordId: input.createdByDiscordId,
          rpName: input.rpName ?? null,
          rpSurname: input.rpSurname ?? null,
          notes: input.notes ?? null,
        },
      });
    },

    async findActive(discordId: string): Promise<BlacklistEntry | null> {
      return db.blacklistEntry.findUnique({ where: { activeKey: discordId } });
    },

    async isBlacklisted(discordId: string): Promise<boolean> {
      const count = await db.blacklistEntry.count({ where: { activeKey: discordId } });
      return count > 0;
    },

    async remove(discordId: string, removedByDiscordId: string, reason?: string): Promise<boolean> {
      const result = await db.blacklistEntry.updateMany({
        where: { activeKey: discordId },
        data: {
          active: false,
          // Libera la sentinella: l'utente potra' essere riblacklistato.
          activeKey: null,
          removedAt: new Date(),
          removedByDiscordId,
          removeReason: reason ?? null,
        },
      });
      return result.count > 0;
    },

    async listActive(options): Promise<BlacklistEntry[]> {
      return db.blacklistEntry.findMany({
        where: { active: true },
        orderBy: { createdAt: 'desc' },
        ...(options?.skip === undefined ? {} : { skip: options.skip }),
        ...(options?.take === undefined ? {} : { take: options.take }),
      });
    },

    async countActive(): Promise<number> {
      return db.blacklistEntry.count({ where: { active: true } });
    },

    async history(discordId: string): Promise<BlacklistEntry[]> {
      return db.blacklistEntry.findMany({
        where: { discordId },
        orderBy: { createdAt: 'desc' },
      });
    },
  };
}
