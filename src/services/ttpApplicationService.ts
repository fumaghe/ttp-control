/**
 * Candidature d'ingresso nella gang.
 *
 * E' il confine fra le due nozioni che il progetto non deve mai confondere:
 *
 *   Verified  = ha completato la verifica            → nessuna approvazione
 *   TTP       = membro effettivo della gang          → serve la Leadership
 *
 * L'approvazione NON reimplementa l'ingresso: delega a `memberService.addToGang`,
 * la stessa funzione usata da `/member add` e `/community makettp`.
 */
import { AuditAction, type MemberRank, TtpApplicationStatus } from '../generated/prisma/enums.js';
import { AppError, ERROR_CODE } from '../errors/AppError.js';
import { DEFAULT_INITIAL_RANK } from '../config/constants.js';
import type { Member, Repositories, TtpApplication } from '../repositories/types.js';
import { lockKey, memberMutex } from '../utils/mutex.js';
import { createLogger } from '../utils/logger.js';
import type { AuditService } from './auditService.js';
import type { MemberService } from './memberService.js';
import type { RoleService } from './roleService.js';
import type { RoleGateway } from './roleGateway.js';

const log = createLogger('applications');

/** Pubblicazione della richiesta nel canale di review. */
export interface ApplicationPublisher {
  /** @returns `channelId` e `messageId` del messaggio pubblicato. */
  publish(application: TtpApplication): Promise<{ channelId: string; messageId: string } | null>;
  /** Aggiorna il messaggio dopo la decisione, disattivando i bottoni. */
  markResolved(application: TtpApplication): Promise<void>;
}

export interface CreateApplicationInput {
  readonly discordId: string;
  readonly username: string;
  readonly displayName: string;
  readonly notes?: string | undefined;
}

export interface ApproveInput {
  readonly applicationId: string;
  readonly actorDiscordId: string;
  readonly initialRank?: MemberRank | undefined;
}

export interface ApproveOutcome {
  readonly application: TtpApplication;
  readonly member: Member;
  readonly rank: MemberRank;
  readonly warnings: readonly string[];
  readonly notified: boolean;
}

export interface RejectInput {
  readonly applicationId: string;
  readonly actorDiscordId: string;
  readonly reason: string;
}

export interface TtpApplicationService {
  create(input: CreateApplicationInput): Promise<TtpApplication>;
  approve(input: ApproveInput): Promise<ApproveOutcome>;
  reject(input: RejectInput): Promise<TtpApplication>;
  cancel(input: {
    discordId: string;
    actorDiscordId: string;
    reason?: string | undefined;
  }): Promise<TtpApplication>;
  findById(id: string): Promise<TtpApplication | null>;
  findPending(discordId: string): Promise<TtpApplication | null>;
  listPending(options?: { skip?: number; take?: number }): Promise<TtpApplication[]>;
  countPending(): Promise<number>;
  historyFor(discordId: string): Promise<TtpApplication[]>;
}

export function createTtpApplicationService(deps: {
  repos: Repositories;
  members: MemberService;
  roles: RoleService;
  gateway: RoleGateway;
  audit: AuditService;
  publisher?: ApplicationPublisher | undefined;
}): TtpApplicationService {
  const { repos, members, roles, gateway, audit, publisher } = deps;

  return {
    async create(input: CreateApplicationInput): Promise<TtpApplication> {
      return memberMutex.run(lockKey('application', input.discordId), async () => {
        const snapshot = await gateway.fetchMember(input.discordId);
        if (!snapshot) {
          throw new AppError(
            ERROR_CODE.TARGET_LEFT_GUILD,
            'Non risulti più presente nel server: rientra e riprova.',
          );
        }

        // --- 1. Blacklist ---------------------------------------------------
        if (await repos.blacklist.isBlacklisted(input.discordId)) {
          throw new AppError(
            ERROR_CODE.BLACKLISTED,
            'Non puoi candidarti. Contatta un OG se ritieni che si tratti di un errore.',
          );
        }

        // --- 2. Verified e' il prerequisito ---------------------------------
        const verification = await repos.verifications.findActive(input.discordId);
        if (!verification) {
          throw new AppError(
            ERROR_CODE.NOT_VERIFIED,
            'Devi prima completare la verifica nel canale dedicato, poi potrai candidarti.',
          );
        }

        // --- 3. Non deve essere gia' membro ---------------------------------
        const member = await repos.members.findByDiscordId(input.discordId);
        if (member && (member.status === 'ACTIVE' || member.status === 'INACTIVE')) {
          throw new AppError(ERROR_CODE.ALREADY_TTP, 'Sei già un membro della gang TTP.');
        }
        if (roles.isTtp(snapshot)) {
          throw new AppError(
            ERROR_CODE.ALREADY_TTP,
            'Hai già il ruolo TTP. Se pensi sia un errore contatta un OG.',
          );
        }

        // --- 4. Una sola candidatura PENDING --------------------------------
        const pending = await repos.applications.findPendingByDiscordId(input.discordId);
        if (pending) {
          throw new AppError(
            ERROR_CODE.APPLICATION_EXISTS,
            'Hai già una candidatura in attesa di revisione. Attendi la risposta della Leadership.',
          );
        }

        await repos.profiles.upsert({
          discordId: input.discordId,
          username: input.username,
          displayName: input.displayName,
        });

        // Se due richieste arrivano insieme, il vincolo `@unique` su
        // `pendingForDiscordId` fa fallire la seconda: la traduciamo nello
        // stesso messaggio del controllo sopra invece di mostrare un errore
        // di database.
        let application: TtpApplication;
        try {
          application = await repos.applications.createPending({
            discordId: input.discordId,
            notes: input.notes,
          });
        } catch (error) {
          const duplicate = await repos.applications.findPendingByDiscordId(input.discordId);
          if (duplicate) {
            throw new AppError(
              ERROR_CODE.APPLICATION_EXISTS,
              'Hai già una candidatura in attesa di revisione.',
              { cause: error },
            );
          }
          throw error;
        }

        await audit.record({
          action: AuditAction.TTP_APPLICATION_CREATED,
          targetDiscordId: input.discordId,
          entityType: 'TtpApplication',
          entityId: application.id,
          metadata: { rpName: verification.rpName, rpSurname: verification.rpSurname },
        });

        // --- 5. Pubblicazione per la Leadership ------------------------------
        if (publisher) {
          try {
            const published = await publisher.publish(application);
            if (published) {
              await repos.applications.attachMessage(
                application.id,
                published.channelId,
                published.messageId,
              );
              application = (await repos.applications.findById(application.id)) ?? application;
            }
          } catch (error) {
            // La candidatura esiste comunque: la Leadership la vede con
            // `/panel`. Non annulliamo un'operazione riuscita.
            log.error(
              { err: error, applicationId: application.id },
              'Pubblicazione della candidatura fallita',
            );
          }
        }

        return application;
      });
    },

    /**
     * APPROVE TTP — e' questa l'operazione che rende qualcuno membro.
     *
     * L'autorizzazione dell'operatore e' gia' stata verificata dall'handler
     * (e viene rifatta a ogni click): qui si controlla lo STATO.
     */
    async approve(input: ApproveInput): Promise<ApproveOutcome> {
      const application = await repos.applications.findById(input.applicationId);
      if (!application) {
        throw new AppError(ERROR_CODE.APPLICATION_NOT_FOUND, 'Candidatura non trovata.');
      }

      return memberMutex.run(lockKey('application', application.discordId), async () => {
        if (application.status !== TtpApplicationStatus.PENDING) {
          throw new AppError(
            ERROR_CODE.APPLICATION_NOT_PENDING,
            `Questa candidatura è già stata gestita (stato: **${application.status}**).`,
          );
        }

        const rank = input.initialRank ?? application.initialRank ?? DEFAULT_INITIAL_RANK;

        // La transizione e' condizionata a `status = PENDING` lato database:
        // di due click simultanei ne passa esattamente uno.
        const resolved = await repos.applications.resolve(application.id, {
          status: TtpApplicationStatus.APPROVED,
          reviewedByDiscordId: input.actorDiscordId,
          initialRank: rank,
        });

        if (!resolved) {
          throw new AppError(
            ERROR_CODE.APPLICATION_NOT_PENDING,
            'Questa candidatura è appena stata gestita da qualcun altro.',
          );
        }

        // L'ingresso vero e proprio: nessuna logica duplicata.
        let outcome;
        try {
          outcome = await members.addToGang({
            discordId: application.discordId,
            actorDiscordId: input.actorDiscordId,
            rank,
            recruitedByDiscordId: input.actorDiscordId,
            reason: 'Candidatura TTP approvata',
            source: 'application',
          });
        } catch (error) {
          // L'ingresso e' fallito: la candidatura torna PENDING, cosi' la
          // Leadership puo' riprovare invece di trovarsi un APPROVED senza
          // `Member` — l'incoerenza peggiore fra quelle possibili.
          const reverted = await repos.applications
            .revertToPending(application.id)
            .catch(() => null);

          if (!reverted) {
            log.error(
              { applicationId: application.id, discordId: application.discordId },
              'Rollback della candidatura fallito: resta APPROVED senza Member, segnalato al sync-check',
            );
            await audit
              .record({
                action: AuditAction.ROLE_SYNC_WARNING,
                actorDiscordId: input.actorDiscordId,
                targetDiscordId: application.discordId,
                entityType: 'TtpApplication',
                entityId: application.id,
                reason:
                  'Candidatura approvata ma ingresso non completato, e rollback non riuscito. Verificare con /system sync-check.',
              })
              .catch(() => undefined);
          }

          throw error;
        }

        await audit.record(
          {
            action: AuditAction.TTP_APPLICATION_APPROVED,
            actorDiscordId: input.actorDiscordId,
            targetDiscordId: application.discordId,
            entityType: 'TtpApplication',
            entityId: application.id,
            newValue: rank,
            metadata: { initialRank: rank, alreadyMember: outcome.alreadyMember },
          },
          ['audit', 'member'],
        );

        // Notifica e aggiornamento del messaggio: entrambi best-effort.
        const notified = await gateway.tryNotify(application.discordId, {
          title: '🩸 Benvenuto nei TTP',
          description:
            'La tua candidatura è stata **approvata**.\nOra fai parte della gang **TTP — Impero**.',
        });

        if (publisher) {
          await publisher.markResolved(resolved).catch((error: unknown) => {
            log.error({ err: error }, 'Aggiornamento del messaggio di candidatura fallito');
          });
        }

        return {
          application: resolved,
          member: outcome.member,
          rank,
          warnings: outcome.warnings,
          notified,
        };
      });
    },

    /**
     * REJECT — l'utente resta `✅ Verified`.
     * Nessun ban, nessuna blacklist: sono azioni separate e deliberate.
     */
    async reject(input: RejectInput): Promise<TtpApplication> {
      const application = await repos.applications.findById(input.applicationId);
      if (!application) {
        throw new AppError(ERROR_CODE.APPLICATION_NOT_FOUND, 'Candidatura non trovata.');
      }

      return memberMutex.run(lockKey('application', application.discordId), async () => {
        const resolved = await repos.applications.resolve(application.id, {
          status: TtpApplicationStatus.REJECTED,
          reviewedByDiscordId: input.actorDiscordId,
          rejectionReason: input.reason,
        });

        if (!resolved) {
          throw new AppError(
            ERROR_CODE.APPLICATION_NOT_PENDING,
            'Questa candidatura è già stata gestita.',
          );
        }

        await audit.record(
          {
            action: AuditAction.TTP_APPLICATION_REJECTED,
            actorDiscordId: input.actorDiscordId,
            targetDiscordId: application.discordId,
            entityType: 'TtpApplication',
            entityId: application.id,
            reason: input.reason,
            // Esplicito: il rifiuto non tocca la verifica.
            metadata: { verifiedPreserved: true },
          },
          ['audit'],
        );

        await gateway.tryNotify(application.discordId, {
          title: 'Candidatura TTP non accettata',
          description: `La tua candidatura non è stata accettata.\n\n**Motivazione:** ${input.reason}\n\nMantieni l'accesso alle aree community.`,
        });

        if (publisher) {
          await publisher.markResolved(resolved).catch((error: unknown) => {
            log.error({ err: error }, 'Aggiornamento del messaggio di candidatura fallito');
          });
        }

        return resolved;
      });
    },

    async cancel(input): Promise<TtpApplication> {
      return memberMutex.run(lockKey('application', input.discordId), async () => {
        const pending = await repos.applications.findPendingByDiscordId(input.discordId);
        if (!pending) {
          throw new AppError(
            ERROR_CODE.APPLICATION_NOT_FOUND,
            'Non hai nessuna candidatura in attesa da annullare.',
          );
        }

        const resolved = await repos.applications.resolve(pending.id, {
          status: TtpApplicationStatus.CANCELLED,
          reviewedByDiscordId: input.actorDiscordId,
          rejectionReason: input.reason,
        });
        if (!resolved) {
          throw new AppError(
            ERROR_CODE.APPLICATION_NOT_PENDING,
            'Questa candidatura è già stata gestita.',
          );
        }

        await audit.record({
          action: AuditAction.TTP_APPLICATION_CANCELLED,
          actorDiscordId: input.actorDiscordId,
          targetDiscordId: input.discordId,
          entityType: 'TtpApplication',
          entityId: pending.id,
          reason: input.reason ?? null,
        });

        if (publisher) {
          await publisher.markResolved(resolved).catch(() => undefined);
        }

        return resolved;
      });
    },

    findById: (id) => repos.applications.findById(id),
    findPending: (discordId) => repos.applications.findPendingByDiscordId(discordId),
    listPending: (options) => repos.applications.listPending(options),
    countPending: () => repos.applications.countPending(),
    historyFor: (discordId) => repos.applications.listByDiscordId(discordId),
  };
}
