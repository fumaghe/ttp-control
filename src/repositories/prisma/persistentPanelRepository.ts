import type { PanelType } from '../../generated/prisma/enums.js';
import type { Database } from '../../database/prisma.js';
import type { PersistentPanel, PersistentPanelRepository } from '../types.js';

export function createPersistentPanelRepository(db: Database): PersistentPanelRepository {
  return {
    async find(guildId: string, panelType: PanelType): Promise<PersistentPanel | null> {
      return db.persistentPanel.findUnique({
        where: { guildId_panelType: { guildId, panelType } },
      });
    },

    /**
     * Un solo record per (guild, tipo): il pannello viene aggiornato, non
     * duplicato. E' questo che impedisce di ripubblicare il verify panel a
     * ogni restart.
     */
    async save(input): Promise<PersistentPanel> {
      return db.persistentPanel.upsert({
        where: { guildId_panelType: { guildId: input.guildId, panelType: input.panelType } },
        create: {
          guildId: input.guildId,
          panelType: input.panelType,
          channelId: input.channelId,
          messageId: input.messageId,
        },
        update: { channelId: input.channelId, messageId: input.messageId },
      });
    },

    async delete(guildId: string, panelType: PanelType): Promise<void> {
      await db.persistentPanel.deleteMany({ where: { guildId, panelType } });
    },
  };
}
