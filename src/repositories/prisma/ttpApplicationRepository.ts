import { TtpApplicationStatus } from '../../generated/prisma/enums.js';
import type { Database } from '../../database/prisma.js';
import type { TtpApplication, TtpApplicationRepository } from '../types.js';

export function createTtpApplicationRepository(db: Database): TtpApplicationRepository {
  return {
    /**
     * `pendingForDiscordId` e' `@unique`: se esiste gia' una candidatura
     * PENDING per lo stesso utente il DATABASE rifiuta l'insert. E' cosi' che
     * regge anche il caso di due richieste inviate nello stesso istante,
     * dove un semplice controllo applicativo non basterebbe.
     */
    async createPending(input): Promise<TtpApplication> {
      return db.ttpApplication.create({
        data: {
          discordId: input.discordId,
          status: TtpApplicationStatus.PENDING,
          pendingForDiscordId: input.discordId,
          notes: input.notes ?? null,
        },
      });
    },

    async findById(id: string): Promise<TtpApplication | null> {
      return db.ttpApplication.findUnique({ where: { id } });
    },

    async findPendingByDiscordId(discordId: string): Promise<TtpApplication | null> {
      return db.ttpApplication.findUnique({ where: { pendingForDiscordId: discordId } });
    },

    async listByDiscordId(discordId: string): Promise<TtpApplication[]> {
      return db.ttpApplication.findMany({
        where: { discordId },
        orderBy: { requestedAt: 'desc' },
      });
    },

    async listPending(options): Promise<TtpApplication[]> {
      return db.ttpApplication.findMany({
        where: { status: TtpApplicationStatus.PENDING },
        orderBy: { requestedAt: 'asc' },
        ...(options?.skip === undefined ? {} : { skip: options.skip }),
        ...(options?.take === undefined ? {} : { take: options.take }),
      });
    },

    async countPending(): Promise<number> {
      return db.ttpApplication.count({ where: { status: TtpApplicationStatus.PENDING } });
    },

    async attachMessage(id: string, channelId: string, messageId: string): Promise<void> {
      await db.ttpApplication.update({ where: { id }, data: { channelId, messageId } });
    },

    /**
     * Transizione condizionata: `updateMany` filtra su `status: PENDING`, cosi'
     * solo il primo dei due click concorrenti trova una riga da aggiornare.
     * Il secondo riceve `count: 0` e ottiene `null` — niente doppia
     * approvazione, nessun bisogno di lock esterni.
     */
    async resolve(id, input): Promise<TtpApplication | null> {
      const result = await db.ttpApplication.updateMany({
        where: { id, status: TtpApplicationStatus.PENDING },
        data: {
          status: input.status,
          // Libera la sentinella: l'utente potra' ricandidarsi in futuro.
          pendingForDiscordId: null,
          reviewedAt: new Date(),
          reviewedByDiscordId: input.reviewedByDiscordId,
          rejectionReason: input.rejectionReason ?? null,
          initialRank: input.initialRank ?? null,
        },
      });

      if (result.count === 0) return null;
      return db.ttpApplication.findUnique({ where: { id } });
    },

    async revertToPending(id: string): Promise<TtpApplication | null> {
      const application = await db.ttpApplication.findUnique({ where: { id } });
      if (!application || application.status === TtpApplicationStatus.PENDING) return null;

      try {
        const result = await db.ttpApplication.updateMany({
          where: { id, status: { not: TtpApplicationStatus.PENDING } },
          data: {
            status: TtpApplicationStatus.PENDING,
            pendingForDiscordId: application.discordId,
            reviewedAt: null,
            reviewedByDiscordId: null,
            rejectionReason: null,
          },
        });
        if (result.count === 0) return null;
        // `await` esplicito: il `catch` sottostante deve poter intercettare
        // anche un fallimento di questa query, non solo dell'update.
        return await db.ttpApplication.findUnique({ where: { id } });
      } catch {
        // `pendingForDiscordId @unique`: nel frattempo l'utente ne ha aperta
        // un'altra. Meglio lasciare le cose come stanno che forzare.
        return null;
      }
    },
  };
}
