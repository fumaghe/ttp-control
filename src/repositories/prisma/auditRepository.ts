import type { Database } from '../../database/prisma.js';
import type { AuditInput, AuditLog, AuditRepository } from '../types.js';

export function createAuditRepository(db: Database): AuditRepository {
  return {
    async record(input: AuditInput): Promise<AuditLog> {
      return db.auditLog.create({
        data: {
          action: input.action,
          actorDiscordId: input.actorDiscordId ?? null,
          targetDiscordId: input.targetDiscordId ?? null,
          entityType: input.entityType ?? null,
          entityId: input.entityId ?? null,
          previousValue: input.previousValue ?? null,
          newValue: input.newValue ?? null,
          reason: input.reason ?? null,
          // Una colonna Json nullable non accetta `null` come valore
          // TypeScript: o si passa il payload, o si omette la chiave del
          // tutto lasciando il default NULL della colonna.
          ...(input.metadata == null ? {} : { metadata: input.metadata }),
        },
      });
    },

    async listRecent(limit = 25): Promise<AuditLog[]> {
      return db.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: limit });
    },

    async listForTarget(discordId: string, limit = 25): Promise<AuditLog[]> {
      return db.auditLog.findMany({
        where: { targetDiscordId: discordId },
        orderBy: { createdAt: 'desc' },
        take: limit,
      });
    },
  };
}
