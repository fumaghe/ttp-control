import type { Database } from '../../database/prisma.js';
import type { GuildConfig, GuildConfigRepository } from '../types.js';

export function createGuildConfigRepository(db: Database): GuildConfigRepository {
  return {
    /** Crea la riga con i default alla prima lettura: nessun setup manuale. */
    async ensure(guildId: string): Promise<GuildConfig> {
      return db.guildConfig.upsert({
        where: { guildId },
        create: { guildId },
        update: {},
      });
    },

    async update(guildId, patch): Promise<GuildConfig> {
      const { createdAt: _createdAt, updatedAt: _updatedAt, ...data } = patch;
      return db.guildConfig.upsert({
        where: { guildId },
        create: { guildId, ...data },
        update: data,
      });
    },
  };
}
