import type { Database } from '../../database/prisma.js';
import type { MemberHistory, MemberHistoryInput, MemberHistoryRepository } from '../types.js';

export function createMemberHistoryRepository(db: Database): MemberHistoryRepository {
  return {
    async record(input: MemberHistoryInput): Promise<MemberHistory> {
      return db.memberHistory.create({
        data: {
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
        },
      });
    },

    async listForMember(memberId: string, limit = 25): Promise<MemberHistory[]> {
      return db.memberHistory.findMany({
        where: { memberId },
        orderBy: { createdAt: 'desc' },
        take: limit,
      });
    },
  };
}
