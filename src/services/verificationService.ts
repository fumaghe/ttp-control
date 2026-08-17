/**
 * Verifica della community.
 *
 * REGOLA DI DOMINIO CENTRALE: la verifica assegna `✅ Verified` e NULLA
 * ALTRO. Non richiede approvazione della Leadership e non assegna mai
 * `🩸 TTP`. Entrare nella gang e' un workflow separato
 * (`ttpApplicationService`).
 *
 *   VALIDATE → CHECK BLACKLIST → CHECK STATE → SAVE → ASSIGN VERIFIED
 *            → AUDIT → RESPOND
 */
import { AuditAction } from '../generated/prisma/enums.js';
import { AppError, ERROR_CODE } from '../errors/AppError.js';
import type { Repositories, Verification } from '../repositories/types.js';
import { lockKey, memberMutex } from '../utils/mutex.js';
import { validateVerificationForm, type VerificationFormInput } from '../utils/validation.js';
import type { AuditService } from './auditService.js';
import type { RoleService } from './roleService.js';
import type { GuildMemberSnapshot, RoleGateway } from './roleGateway.js';

/**
 * Il form arriva grezzo dal modal. Il service lo rivalida comunque, anche se
 * l'handler lo ha gia' fatto: la difesa non puo' dipendere da chi chiama.
 */
export interface RawVerificationForm {
  readonly rpName: string | null;
  readonly oocName: string | null;
}

export interface VerifyRequest {
  readonly discordId: string;
  readonly username: string;
  readonly displayName: string;
  readonly form: RawVerificationForm | VerificationFormInput;
}

export type VerifyOutcome =
  /** Verifica registrata e ruolo assegnato. */
  | { readonly kind: 'verified'; readonly verification: Verification }
  /** Era gia' verificato: nulla da fare, ma il ruolo e' stato riallineato. */
  | { readonly kind: 'already-verified'; readonly verification: Verification };

export interface VerificationService {
  verify(request: VerifyRequest): Promise<VerifyOutcome>;
  /** Revoca amministrativa della verifica (usata da `/community revoke`). */
  revoke(input: {
    discordId: string;
    actorDiscordId: string;
    reason?: string | undefined;
  }): Promise<void>;
}

export function createVerificationService(deps: {
  repos: Repositories;
  roles: RoleService;
  gateway: RoleGateway;
  audit: AuditService;
}): VerificationService {
  const { repos, roles, gateway, audit } = deps;

  return {
    async verify(request: VerifyRequest): Promise<VerifyOutcome> {
      // Serializza le verifiche dello stesso utente: due submit ravvicinati
      // del modal non devono produrre due percorsi paralleli.
      // Validazione e normalizzazione: fuori dal lock, non tocca stato.
      const form = validateVerificationForm({
        rpName: request.form.rpName ?? null,
        oocName: request.form.oocName ?? null,
      });
      return memberMutex.run(lockKey('verify', request.discordId), async () => {
        // --- 1. Il membro e' ancora nel server? --------------------------
        const snapshot = await gateway.fetchMember(request.discordId);
        if (!snapshot) {
          throw new AppError(
            ERROR_CODE.TARGET_LEFT_GUILD,
            'Non risulti più presente nel server: rientra e riprova.',
          );
        }

        // --- 2. Blacklist: il DB e' autorevole, non il ruolo Discord -----
        const blacklisted = await repos.blacklist.findActive(request.discordId);
        if (blacklisted) {
          // L'audit serve: un tentativo di verifica da parte di un
          // blacklistato e' un'informazione che la Leadership vuole avere.
          await audit.record(
            {
              action: AuditAction.BLACKLISTED_USER_REJOINED,
              targetDiscordId: request.discordId,
              entityType: 'BlacklistEntry',
              entityId: blacklisted.id,
              reason: 'Tentativo di verifica da parte di un utente in blacklist',
              metadata: { attempted: 'verify' },
            },
            ['audit', 'blacklist'],
          );

          throw new AppError(
            ERROR_CODE.BLACKLISTED,
            'Non puoi completare la verifica. Contatta un OG se ritieni che si tratti di un errore.',
          );
        }

        // --- 3. Anagrafica ------------------------------------------------
        await repos.profiles.upsert({
          discordId: request.discordId,
          username: request.username,
          displayName: request.displayName,
        });

        // --- 4. Stato corrente: idempotenza -------------------------------
        const existing = await repos.verifications.findActive(request.discordId);
        if (existing) {
          // Gia' verificato. Non e' un errore: riallineiamo il ruolo se per
          // qualche motivo manca e rispondiamo con eleganza.
          if (!roles.isVerified(snapshot)) {
            await roles.assignVerified(
              request.discordId,
              'Riallineamento: verifica già presente a database',
            );
          }
          return { kind: 'already-verified', verification: existing };
        }

        // --- 5. Persistenza PRIMA del ruolo -------------------------------
        // Ordine deliberato: se Discord fallisce resta una verifica a DB
        // senza ruolo, che il sync-check segnala e un operatore risolve.
        // L'ordine opposto darebbe un ruolo senza traccia: invisibile.
        const verification = await repos.verifications.create({
          discordId: request.discordId,
          ...form,
        });
        await repos.profiles.setVerifiedAt(request.discordId, verification.verifiedAt);

        // --- 6. Ruolo Verified — MAI il ruolo TTP -------------------------
        await roles.assignVerified(request.discordId, 'Verifica community completata');

        // --- 7. Audit ------------------------------------------------------
        await audit.record({
          action: AuditAction.USER_VERIFIED,
          targetDiscordId: request.discordId,
          entityType: 'Verification',
          entityId: verification.id,
          metadata: {
            rpName: verification.rpName,
            oocName: verification.oocName,
          },
        });

        return { kind: 'verified', verification };
      });
    },

    async revoke(input): Promise<void> {
      await memberMutex.run(lockKey('verify', input.discordId), async () => {
        const active = await repos.verifications.findActive(input.discordId);
        if (!active) {
          throw new AppError(
            ERROR_CODE.NOT_VERIFIED,
            'Questo utente non ha una verifica attiva da revocare.',
          );
        }

        await repos.verifications.revoke(input.discordId, input.actorDiscordId, input.reason);
        await repos.profiles.setVerifiedAt(input.discordId, null);

        await audit.record({
          action: AuditAction.VERIFICATION_REVOKED,
          actorDiscordId: input.actorDiscordId,
          targetDiscordId: input.discordId,
          entityType: 'Verification',
          entityId: active.id,
          reason: input.reason ?? null,
        });
      });
    },
  };
}

/** Snapshot + verifica, coppia usata spesso dai comandi informativi. */
export interface VerificationState {
  readonly snapshot: GuildMemberSnapshot | null;
  readonly verification: Verification | null;
}
