import { MemberRank, MemberStatus } from '../../generated/prisma/enums.js';
import type { Database } from '../../database/prisma.js';
import type {
  Member,
  MemberCounts,
  MemberCreateInput,
  MemberFilter,
  MemberRepository,
} from '../types.js';

function emptyRankTally(): Record<MemberRank, number> {
  return {
    [MemberRank.RESIDENT]: 0,
    [MemberRank.GANGSTER]: 0,
    [MemberRank.YOUNG_OG]: 0,
    [MemberRank.BIG]: 0,
    [MemberRank.OG]: 0,
  };
}

export function createMemberRepository(db: Database): MemberRepository {
  return {
    async findByDiscordId(discordId: string): Promise<Member | null> {
      return db.member.findUnique({ where: { discordId } });
    },

    async findById(id: string): Promise<Member | null> {
      return db.member.findUnique({ where: { id } });
    },

    async create(input: MemberCreateInput): Promise<Member> {
      return db.member.create({
        data: {
          discordId: input.discordId,
          rank: input.rank,
          status: MemberStatus.ACTIVE,
          rpName: input.rpName ?? null,
          rpSurname: input.rpSurname ?? null,
          citizenId: input.citizenId ?? null,
          phone: input.phone ?? null,
          recruitedByDiscordId: input.recruitedByDiscordId ?? null,
          notes: input.notes ?? null,
          joinedTtpAt: new Date(),
        },
      });
    },

    async list(filter?: MemberFilter): Promise<Member[]> {
      return db.member.findMany({
        where: {
          ...(filter?.rank === undefined ? {} : { rank: filter.rank }),
          ...(filter?.status === undefined ? {} : { status: filter.status }),
          ...(filter?.statusIn === undefined ? {} : { status: { in: [...filter.statusIn] } }),
        },
        orderBy: [{ rank: 'desc' }, { joinedTtpAt: 'asc' }],
      });
    },

    async counts(): Promise<MemberCounts> {
      // Due sole query aggregate invece di una per combinazione.
      const [byStatus, byRank] = await Promise.all([
        db.member.groupBy({ by: ['status'], _count: { _all: true } }),
        db.member.groupBy({
          by: ['rank'],
          where: { status: { in: [MemberStatus.ACTIVE, MemberStatus.INACTIVE] } },
          _count: { _all: true },
        }),
      ]);

      const statusTally: Record<MemberStatus, number> = {
        [MemberStatus.ACTIVE]: 0,
        [MemberStatus.INACTIVE]: 0,
        [MemberStatus.PERMADEATH]: 0,
        [MemberStatus.LEFT]: 0,
      };
      for (const row of byStatus) statusTally[row.status] = row._count._all;

      const rankTally = emptyRankTally();
      for (const row of byRank) rankTally[row.rank] = row._count._all;

      return {
        // "Total" sono i membri attualmente nella gang: chi e' uscito o e'
        // in permadeath resta a DB ma non fa piu' parte del roster.
        total: statusTally.ACTIVE + statusTally.INACTIVE,
        active: statusTally.ACTIVE,
        inactive: statusTally.INACTIVE,
        permadeath: statusTally.PERMADEATH,
        left: statusTally.LEFT,
        byRank: rankTally,
      };
    },

    async countByStatus(status: MemberStatus): Promise<number> {
      return db.member.count({ where: { status } });
    },

    /**
     * Locking ottimistico: il `where` include la versione attesa, quindi due
     * promote partiti dallo stesso stato non possono comporsi — il secondo
     * non trova righe e ottiene `null`.
     */
    async updateWithVersion(id, expectedVersion, patch): Promise<Member | null> {
      const result = await db.member.updateMany({
        where: { id, version: expectedVersion },
        data: {
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
          version: { increment: 1 },
        },
      });

      if (result.count === 0) return null;
      return db.member.findUnique({ where: { id } });
    },

    async setNotes(id: string, notes: string | null): Promise<Member> {
      return db.member.update({ where: { id }, data: { notes } });
    },
  };
}
