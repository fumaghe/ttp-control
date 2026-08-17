import type { SpecialRole } from '../../generated/prisma/enums.js';
import type { Database } from '../../database/prisma.js';
import type { MemberSpecialRole, MemberSpecialRoleRepository } from '../types.js';

/** Sentinella di unicita': un solo record attivo per (membro, ruolo). */
function activeKey(memberId: string, role: SpecialRole): string {
  return `${memberId}:${role}`;
}

export function createMemberSpecialRoleRepository(db: Database): MemberSpecialRoleRepository {
  return {
    async listActive(memberId: string): Promise<MemberSpecialRole[]> {
      return db.memberSpecialRole.findMany({
        where: { memberId, removedAt: null },
        orderBy: { assignedAt: 'asc' },
      });
    },

    /**
     * Idempotente: se il ruolo e' gia' attivo restituisce `null` invece di
     * creare un duplicato. La garanzia e' del DB (`activeKey @unique`), qui
     * evitiamo solo di far arrivare l'errore al chiamante.
     */
    async add(
      memberId: string,
      role: SpecialRole,
      actorDiscordId: string,
    ): Promise<MemberSpecialRole | null> {
      const existing = await db.memberSpecialRole.findUnique({
        where: { activeKey: activeKey(memberId, role) },
      });
      if (existing) return null;

      return db.memberSpecialRole.create({
        data: {
          memberId,
          role,
          activeKey: activeKey(memberId, role),
          assignedByDiscordId: actorDiscordId,
        },
      });
    },

    async remove(memberId: string, role: SpecialRole, actorDiscordId: string): Promise<boolean> {
      const result = await db.memberSpecialRole.updateMany({
        where: { activeKey: activeKey(memberId, role) },
        data: {
          // Libera la sentinella: il ruolo potra' essere riassegnato.
          activeKey: null,
          removedAt: new Date(),
          removedByDiscordId: actorDiscordId,
        },
      });
      return result.count > 0;
    },

    async removeAll(memberId: string, actorDiscordId: string): Promise<SpecialRole[]> {
      const active = await db.memberSpecialRole.findMany({
        where: { memberId, removedAt: null },
      });
      if (active.length === 0) return [];

      await db.memberSpecialRole.updateMany({
        where: { memberId, removedAt: null },
        data: { activeKey: null, removedAt: new Date(), removedByDiscordId: actorDiscordId },
      });

      return active.map((entry) => entry.role);
    },
  };
}
