/**
 * Snapshot dello stato Discord dei membri, per la riconciliazione periodica.
 */
import type { Database } from '../../database/prisma.js';
import type {
  GuildMemberSnapshotRepository,
  GuildMemberSnapshotRow,
  GuildMemberSnapshotUpsert,
} from '../types.js';

export function createGuildMemberSnapshotRepository(db: Database): GuildMemberSnapshotRepository {
  return {
    async listForGuild(guildId): Promise<GuildMemberSnapshotRow[]> {
      const rows = await db.guildMemberSnapshot.findMany({
        where: { guildId },
        select: {
          discordId: true,
          inGuild: true,
          roleIds: true,
          rolesHash: true,
          nickname: true,
        },
      });
      return rows.map((row) => ({
        discordId: row.discordId,
        inGuild: row.inGuild,
        roleIds: row.roleIds,
        rolesHash: row.rolesHash,
        nickname: row.nickname,
      }));
    },

    async countForGuild(guildId): Promise<number> {
      return db.guildMemberSnapshot.count({ where: { guildId } });
    },

    /**
     * Scrive gli snapshot osservati.
     *
     * Una `upsert` per membro, in serie: su Workers una transazione lunga
     * tiene occupata una connessione Hyperdrive per tutta la durata del cron,
     * e la riconciliazione e' idempotente per costruzione — non serve
     * atomicita' sull'intero lotto.
     */
    async upsertMany(rows: readonly GuildMemberSnapshotUpsert[]): Promise<void> {
      for (const row of rows) {
        await db.guildMemberSnapshot.upsert({
          where: { guildId_discordId: { guildId: row.guildId, discordId: row.discordId } },
          create: {
            guildId: row.guildId,
            discordId: row.discordId,
            inGuild: row.inGuild,
            roleIds: [...row.roleIds],
            rolesHash: row.rolesHash,
            nickname: row.nickname ?? null,
            firstSeenAt: row.seenAt,
            lastSeenAt: row.seenAt,
            lastReconciledAt: row.seenAt,
          },
          update: {
            inGuild: row.inGuild,
            roleIds: [...row.roleIds],
            rolesHash: row.rolesHash,
            nickname: row.nickname ?? null,
            lastSeenAt: row.seenAt,
            lastReconciledAt: row.seenAt,
            // Un rientro azzera la data di uscita: la riga descrive lo stato
            // corrente, lo storico vive nell'audit.
            leftAt: null,
          },
        });
      }
    },

    /** Il membro non compare piu' nell'enumerazione: riga conservata. */
    async markLeft(guildId, discordId, at): Promise<void> {
      await db.guildMemberSnapshot.updateMany({
        where: { guildId, discordId },
        data: { inGuild: false, leftAt: at, lastReconciledAt: at },
      });
    },
  };
}
