import type { Database } from '../../database/prisma.js';
import type { Verification, VerificationInput, VerificationRepository } from '../types.js';

export function createVerificationRepository(db: Database): VerificationRepository {
  return {
    /**
     * Upsert invece di create: se esiste una verifica revocata, la
     * riattiviamo con i dati nuovi azzerando i campi di revoca. Il vincolo
     * `discordId @unique` rende l'operazione sicura anche sotto concorrenza.
     */
    async create(input: VerificationInput): Promise<Verification> {
      const now = new Date();

      return db.verification.upsert({
        where: {
          discordId: input.discordId,
        },

        create: {
          discordId: input.discordId,
          rpName: input.rpName,
          oocName: input.oocName,

          rpSurname: null,
          citizenId: null,
          phone: null,
          referral: null,

          verifiedAt: now,
        },

        update: {
          rpName: input.rpName,
          oocName: input.oocName,

          rpSurname: null,
          citizenId: null,
          phone: null,
          referral: null,

          verifiedAt: now,
          revokedAt: null,
          revokedByDiscordId: null,
          revokeReason: null,
        },
      });
    },

    async findByDiscordId(discordId: string): Promise<Verification | null> {
      return db.verification.findUnique({ where: { discordId } });
    },

    async findActive(discordId: string): Promise<Verification | null> {
      return db.verification.findFirst({ where: { discordId, revokedAt: null } });
    },

    async revoke(discordId: string, revokedByDiscordId: string, reason?: string): Promise<void> {
      await db.verification.updateMany({
        where: { discordId, revokedAt: null },
        data: { revokedAt: new Date(), revokedByDiscordId, revokeReason: reason ?? null },
      });
    },

    async countActive(): Promise<number> {
      return db.verification.count({ where: { revokedAt: null } });
    },
  };
}
