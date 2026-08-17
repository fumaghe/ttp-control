/**
 * Membership TTP: ingresso, gerarchia, ruoli speciali, stato, uscita.
 *
 * E' l'unica implementazione di questa logica: slash command, bottoni,
 * select menu e control panel la richiamano tutti da qui.
 *
 * ORDINE DELLE OPERAZIONI E COMPENSAZIONE
 * Le chiamate all'API Discord non possono stare dentro una transazione
 * PostgreSQL, quindi l'atomicita' perfetta non esiste. La scelta e':
 *
 *   1. prima il database, con locking ottimistico su `Member.version`;
 *   2. poi Discord;
 *   3. se Discord fallisce, si annulla la modifica a database (compensazione)
 *      e si segnala l'errore.
 *
 * Cosi' il caso peggiore e' "nessuna modifica" invece di "database e Discord
 * che raccontano cose diverse". Se anche la compensazione fallisce lo si
 * registra come ROLE_SYNC_WARNING: `/system sync-check` lo fara' emergere.
 *
 * L'ordine completo di un cambio di rank e' quindi:
 *
 *   validazione → DB → Discord → compensazione → MemberHistory → Audit
 *   → annuncio Put On/Put Off (best-effort)
 *
 * L'annuncio pubblico e' ultimo perche' e' l'unico passo non autorevole: se
 * fallisce si logga e basta, senza rollback, senza ritentativi e senza
 * toccare `Member.version`.
 */
import {
  AuditAction,
  MemberHistoryEvent,
  type MemberRank,
  MemberStatus,
  type SpecialRole,
} from '../generated/prisma/enums.js';
import { AppError, ConcurrencyError, ERROR_CODE } from '../errors/AppError.js';
import { DEFAULT_INITIAL_RANK, nextRank, previousRank, RANK_LABEL } from '../config/constants.js';
import type { Member, MemberCounts, MemberFilter, Repositories } from '../repositories/types.js';
import { lockKey, memberMutex } from '../utils/mutex.js';
import { createLogger } from '../utils/logger.js';
import type { RoleRegistry } from '../config/roles.js';
import type { AuditService } from './auditService.js';
import type { RankAnnouncementService } from './rankAnnouncementService.js';
import type { RoleService } from './roleService.js';
import type { GuildMemberSnapshot, RoleGateway } from './roleGateway.js';

const log = createLogger('member');

/** Stati in cui un `Member` fa ancora parte della gang. */
const IN_GANG: readonly MemberStatus[] = [MemberStatus.ACTIVE, MemberStatus.INACTIVE];

/** Lo stato indica che il membro fa ancora parte della gang. */
export function statusIsInGang(status: MemberStatus): boolean {
  return IN_GANG.includes(status);
}

/**
 * Type predicate comodo per i punti in cui si vuole uscire subito
 * (`if (!isInGang(m)) throw ...`).
 *
 * Attenzione: nel ramo negativo TypeScript restringe a `null`, quindi dove
 * serve conservare `Member | null` va usato `statusIsInGang`.
 */
export function isInGang(member: Member | null): member is Member {
  return member !== null && statusIsInGang(member.status);
}

export interface AddToGangInput {
  readonly discordId: string;
  readonly actorDiscordId: string;
  readonly rank?: MemberRank | undefined;
  readonly recruitedByDiscordId?: string | undefined;
  readonly notes?: string | undefined;
  readonly reason?: string | undefined;
  /** Da dove arriva l'ingresso: cambia solo l'audit, non la logica. */
  readonly source: 'application' | 'manual';
}

export interface AddToGangOutcome {
  readonly member: Member;
  /** `true` se era gia' membro: operazione idempotente, ruoli riallineati. */
  readonly alreadyMember: boolean;
  /** Combinazioni insolite da segnalare all'operatore (non bloccanti). */
  readonly warnings: readonly string[];
}

export interface RankChangeOutcome {
  readonly member: Member;
  readonly fromRank: MemberRank;
  readonly toRank: MemberRank;
}

export interface StatusChangeOutcome {
  readonly member: Member;
  readonly changed: boolean;
}

export interface RemoveOutcome {
  readonly member: Member;
  readonly removedSpecialRoles: readonly SpecialRole[];
}

export interface MemberService {
  find(discordId: string): Promise<Member | null>;
  /** Il membro, oppure un errore se non fa (piu') parte della gang. */
  requireInGang(discordId: string): Promise<Member>;

  addToGang(input: AddToGangInput): Promise<AddToGangOutcome>;
  promote(input: {
    discordId: string;
    actorDiscordId: string;
    reason: string;
  }): Promise<RankChangeOutcome>;
  demote(input: {
    discordId: string;
    actorDiscordId: string;
    reason: string;
  }): Promise<RankChangeOutcome>;
  setRank(input: {
    discordId: string;
    actorDiscordId: string;
    rank: MemberRank;
    reason: string;
  }): Promise<RankChangeOutcome>;

  addSpecialRole(input: {
    discordId: string;
    actorDiscordId: string;
    role: SpecialRole;
  }): Promise<boolean>;
  removeSpecialRole(input: {
    discordId: string;
    actorDiscordId: string;
    role: SpecialRole;
  }): Promise<boolean>;
  listSpecialRoles(memberId: string): Promise<SpecialRole[]>;

  setInactive(input: {
    discordId: string;
    actorDiscordId: string;
    reason?: string | undefined;
  }): Promise<StatusChangeOutcome>;
  setActive(input: {
    discordId: string;
    actorDiscordId: string;
    reason?: string | undefined;
  }): Promise<StatusChangeOutcome>;

  removeFromGang(input: {
    discordId: string;
    actorDiscordId: string;
    reason: string;
  }): Promise<RemoveOutcome>;
  permadeath(input: {
    discordId: string;
    actorDiscordId: string;
    reason: string;
  }): Promise<RemoveOutcome>;

  setNotes(input: {
    discordId: string;
    actorDiscordId: string;
    notes: string | null;
  }): Promise<Member>;

  roster(filter?: MemberFilter): Promise<Member[]>;
  counts(): Promise<MemberCounts>;
}

export function createMemberService(deps: {
  repos: Repositories;
  roles: RoleService;
  roleRegistry: RoleRegistry;
  gateway: RoleGateway;
  audit: AuditService;
  /**
   * Annunci pubblici Put On / Put Off. Volutamente NON opzionale: e' un
   * effetto della mutazione di rank, non una decorazione del chiamante, e
   * renderlo obbligatorio fa fallire il typecheck se un giorno qualcuno
   * costruisce il service dimenticandolo.
   */
  announcements: RankAnnouncementService;
  guildId: string;
}): MemberService {
  const { repos, roles, roleRegistry, gateway, audit, announcements, guildId } = deps;

  /** Snapshot Discord obbligatorio: il bersaglio deve essere nel server. */
  async function requireSnapshot(discordId: string): Promise<GuildMemberSnapshot> {
    const snapshot = await gateway.fetchMember(discordId);
    if (!snapshot) {
      throw new AppError(
        ERROR_CODE.TARGET_LEFT_GUILD,
        'Questo utente non è più presente nel server Discord.',
      );
    }
    return snapshot;
  }

  /**
   * Annulla una modifica a database dopo un fallimento Discord.
   * Non lancia: l'errore originale e' piu' importante di quello della
   * compensazione, che pero' viene registrato come divergenza.
   */
  async function compensate(
    member: Member,
    newVersion: number,
    patch: Parameters<Repositories['members']['updateWithVersion']>[2],
    context: Record<string, unknown>,
  ): Promise<void> {
    try {
      const reverted = await repos.members.updateWithVersion(member.id, newVersion, patch);
      if (reverted) return;
      log.error(
        { ...context, memberId: member.id },
        'Compensazione non applicata: versione mutata',
      );
    } catch (error) {
      log.error({ err: error, ...context, memberId: member.id }, 'Compensazione fallita');
    }

    // Non siamo riusciti a tornare indietro: DB e Discord possono divergere.
    await audit
      .record({
        action: AuditAction.ROLE_SYNC_WARNING,
        targetDiscordId: member.discordId,
        entityType: 'Member',
        entityId: member.id,
        reason: 'Compensazione fallita dopo un errore Discord: verificare con /system sync-check',
        metadata: { context: JSON.stringify(context) },
      })
      .catch((error: unknown) => {
        log.error({ err: error }, 'Impossibile registrare il ROLE_SYNC_WARNING');
      });
  }

  /** Nucleo condiviso da promote, demote e cambio rank diretto. */
  async function changeRank(input: {
    discordId: string;
    actorDiscordId: string;
    reason: string;
    resolve: (current: MemberRank) => MemberRank;
    event: MemberHistoryEvent;
    action: AuditAction;
  }): Promise<RankChangeOutcome> {
    // Lettura PRIMA del lock: e' lo stato che l'operatore aveva davanti quando
    // ha deciso. Serializzare e basta non basterebbe — il secondo di due
    // promote simultanei rileggerebbe lo stato gia' avanzato e comporrebbe
    // `Gangster → Young OG → Big`, che e' esattamente il caso da impedire.
    const observed = await repos.members.findByDiscordId(input.discordId);
    if (!isInGang(observed)) {
      throw new AppError(
        ERROR_CODE.NOT_TTP,
        'Questo utente non è un membro TTP: non ha un rank da modificare.',
      );
    }
    const observedVersion = observed.version;

    return memberMutex.run(lockKey('member', input.discordId), async () => {
      const member = await repos.members.findByDiscordId(input.discordId);
      if (!isInGang(member)) {
        throw new AppError(
          ERROR_CODE.NOT_TTP,
          'Questo utente non è un membro TTP: non ha un rank da modificare.',
        );
      }

      // Lo stato e' cambiato fra la decisione e l'esecuzione: l'operazione va
      // rifiutata, non riapplicata sul nuovo stato.
      if (member.version !== observedVersion) {
        throw new ConcurrencyError(
          'Il rank di questo membro è stato modificato da qualcun altro un istante fa. Ricontrolla lo stato e riprova.',
        );
      }

      const snapshot = await requireSnapshot(input.discordId);
      const fromRank = member.rank;
      const toRank = input.resolve(fromRank);

      if (toRank === fromRank) {
        throw new AppError(
          ERROR_CODE.RANK_UNCHANGED,
          `Il membro è già **${RANK_LABEL[toRank]}**: nessuna modifica da applicare.`,
        );
      }

      // --- 1. Database, con guardia di concorrenza ------------------------
      const updated = await repos.members.updateWithVersion(member.id, member.version, {
        rank: toRank,
      });
      if (!updated) {
        throw new ConcurrencyError(
          'Il rank di questo membro è stato modificato da qualcun altro un istante fa. Ricontrolla lo stato e riprova.',
        );
      }

      // --- 2. Discord, con compensazione in caso di errore ----------------
      try {
        await roles.setHierarchyRank(input.discordId, toRank, input.reason);
      } catch (error) {
        await compensate(
          member,
          updated.version,
          { rank: fromRank },
          { operation: 'changeRank', fromRank, toRank },
        );
        throw error;
      }

      // --- 3. Storico e audit ---------------------------------------------
      await repos.history.record({
        memberId: member.id,
        discordId: member.discordId,
        event: input.event,
        fromRank,
        toRank,
        actorDiscordId: input.actorDiscordId,
        reason: input.reason,
      });

      await audit.record(
        {
          action: input.action,
          actorDiscordId: input.actorDiscordId,
          targetDiscordId: input.discordId,
          entityType: 'Member',
          entityId: member.id,
          previousValue: fromRank,
          newValue: toRank,
          reason: input.reason,
          metadata: { hadRolesBefore: [...snapshot.roleIds].length },
        },
        ['audit', 'member'],
      );

      // --- 4. Annuncio pubblico Put On / Put Off ---------------------------
      // ULTIMO PASSO, E BEST-EFFORT. Arriva qui e non prima perche' e' l'unica
      // parte non autorevole dell'operazione: database, ruoli Discord,
      // storico e audit sono gia' scritti e non vengono piu' rimessi in
      // discussione. Il service non lancia per contratto; il `catch` e' la
      // cintura di sicurezza se un giorno cambiasse idea.
      //
      // La direzione la calcola il service da RANK_ORDER: qui non si
      // confrontano stringhe, e `promote`/`demote`/`setRank` producono lo
      // stesso annuncio perche' passano tutti da questo punto.
      await announcements
        .announceRankChange({
          memberDiscordId: member.discordId,
          actorDiscordId: input.actorDiscordId,
          fromRank,
          toRank,
          reason: input.reason,
        })
        .catch((error: unknown) => {
          log.error(
            { err: error, discordId: member.discordId, fromRank, toRank },
            'Annuncio Put On/Put Off fallito: il cambio di rank resta valido',
          );
        });

      return { member: updated, fromRank, toRank };
    });
  }

  const service: MemberService = {
    find: (discordId) => repos.members.findByDiscordId(discordId),

    async requireInGang(discordId: string): Promise<Member> {
      const member = await repos.members.findByDiscordId(discordId);
      if (!isInGang(member)) {
        throw new AppError(ERROR_CODE.NOT_TTP, 'Questo utente non è un membro TTP.');
      }
      return member;
    },

    async addToGang(input: AddToGangInput): Promise<AddToGangOutcome> {
      return memberMutex.run(lockKey('member', input.discordId), async () => {
        const rank = input.rank ?? DEFAULT_INITIAL_RANK;
        const warnings: string[] = [];

        const snapshot = await requireSnapshot(input.discordId);

        // --- Blacklist: sbarramento assoluto ------------------------------
        if (await repos.blacklist.isBlacklisted(input.discordId)) {
          throw new AppError(
            ERROR_CODE.BLACKLISTED,
            'Questo utente è in blacklist: rimuovilo dalla blacklist prima di aggiungerlo alla gang.',
          );
        }

        // --- `TTP ⇒ Verified`: la verifica e' un prerequisito -------------
        const verification = await repos.verifications.findActive(input.discordId);
        if (!verification) {
          throw new AppError(
            ERROR_CODE.NOT_VERIFIED,
            'Questo utente non ha completato la verifica. Deve prima verificarsi, oppure usa `/community verified` per assegnargliela manualmente.',
          );
        }

        // --- Idempotenza ---------------------------------------------------
        // Volutamente `statusIsInGang` e non il type predicate: qui serve che
        // `existing` resti `Member | null` anche dopo il controllo, perche' un
        // ex membro va riusato invece di crearne uno nuovo.
        const existing = await repos.members.findByDiscordId(input.discordId);
        if (existing !== null && statusIsInGang(existing.status)) {
          // Gia' membro: riallineiamo i ruoli Discord e ci fermiamo.
          if (!roles.isTtp(snapshot) || roles.readRank(snapshot) !== existing.rank) {
            await roles.assignTtpWithRank(
              input.discordId,
              existing.rank,
              'Riallineamento: membro già presente a database',
            );
          }
          return { member: existing, alreadyMember: true, warnings };
        }

        const config = await repos.guildConfig.ensure(guildId);

        // --- Discord PRIMA del database ---------------------------------------
        // Ordine opposto a quello di `changeRank`, e per un motivo preciso: qui
        // non esiste ancora una riga da versionare, quindi se Discord fallisce
        // la cosa piu' pulita e' non aver creato nulla. Un `Member` ACTIVE
        // senza ruolo TTP sarebbe un fantasma da ripulire a mano.
        await roles.assignTtpWithRank(
          input.discordId,
          rank,
          input.reason ?? 'Ingresso nella gang TTP',
        );

        // --- Persistenza --------------------------------------------------------
        let member: Member | null;
        try {
          member = existing
            ? // Rientro di un ex membro: si riusa la riga, lo storico resta.
              await repos.members.updateWithVersion(existing.id, existing.version, {
                rank,
                status: MemberStatus.ACTIVE,
                joinedTtpAt: new Date(),
                leftTtpAt: null,
                recruitedByDiscordId: input.recruitedByDiscordId ?? null,
                ...(input.notes === undefined ? {} : { notes: input.notes }),
                rpName: verification.rpName,
                rpSurname: verification.rpSurname,
                citizenId: verification.citizenId,
                phone: verification.phone,
              })
            : await repos.members.create({
                discordId: input.discordId,
                rank,
                rpName: verification.rpName,
                rpSurname: verification.rpSurname,
                citizenId: verification.citizenId,
                phone: verification.phone,
                recruitedByDiscordId: input.recruitedByDiscordId ?? null,
                notes: input.notes ?? null,
              });
        } catch (error) {
          // Il database non ha retto: togliamo i ruoli appena assegnati,
          // altrimenti resterebbe un TTP che il gestionale non conosce.
          await roles
            .removeTtp(input.discordId, 'Rollback: ingresso non registrato a database')
            .catch((rollbackError: unknown) => {
              log.error(
                { err: rollbackError, discordId: input.discordId },
                'Rollback dei ruoli fallito dopo un errore a database',
              );
            });
          throw error;
        }

        if (!member) {
          await roles
            .removeTtp(input.discordId, 'Rollback: stato del membro cambiato durante l’ingresso')
            .catch(() => undefined);
          throw new ConcurrencyError(
            'Lo stato di questo membro è cambiato durante l’operazione. Riprova.',
          );
        }

        // Friend e Mafia NON vengono tolti d'ufficio: e' una decisione della
        // Leadership, non un effetto collaterale dell'ingresso. Di default si
        // segnala la combinazione insolita e basta.
        const communityRoles = [
          { key: 'friend', id: roleRegistry.friend, label: '🤝 Friend' },
          { key: 'mafia', id: roleRegistry.mafia, label: '🕴 Mafia' },
        ] as const;

        for (const community of communityRoles) {
          if (!snapshot.roleIds.has(community.id)) continue;
          if (config.removeCommunityRolesOnJoin) {
            await roles.removeCommunityRole(
              input.discordId,
              community.key,
              'Ingresso nella gang TTP',
            );
            warnings.push(`Rimosso ${community.label} in base alla policy della gang.`);
          } else {
            warnings.push(
              `Il membro conserva ${community.label}: rimuovilo a mano se non è voluto.`,
            );
          }
        }

        // --- Storico e audit --------------------------------------------------
        await repos.history.record({
          memberId: member.id,
          discordId: member.discordId,
          event: MemberHistoryEvent.JOINED_TTP,
          toRank: rank,
          toStatus: MemberStatus.ACTIVE,
          actorDiscordId: input.actorDiscordId,
          reason: input.reason ?? null,
        });

        await audit.record(
          {
            action: AuditAction.TTP_ADDED,
            actorDiscordId: input.actorDiscordId,
            targetDiscordId: input.discordId,
            entityType: 'Member',
            entityId: member.id,
            newValue: rank,
            reason: input.reason ?? null,
            metadata: {
              source: input.source,
              recruitedBy: input.recruitedByDiscordId ?? null,
            },
          },
          ['audit', 'member'],
        );

        return { member, alreadyMember: false, warnings };
      });
    },

    promote: (input) =>
      changeRank({
        ...input,
        event: MemberHistoryEvent.PROMOTED,
        action: AuditAction.PROMOTED,
        resolve: (current) => {
          const target = nextRank(current);
          if (!target) {
            throw new AppError(
              ERROR_CODE.RANK_AT_MAXIMUM,
              `Il membro è già **${RANK_LABEL[current]}**, il rank più alto della gerarchia.`,
            );
          }
          return target;
        },
      }),

    demote: (input) =>
      changeRank({
        ...input,
        event: MemberHistoryEvent.DEMOTED,
        action: AuditAction.DEMOTED,
        resolve: (current) => {
          const target = previousRank(current);
          if (!target) {
            throw new AppError(
              ERROR_CODE.RANK_AT_MINIMUM,
              `Il membro è già **${RANK_LABEL[current]}**, il rank più basso.\nPer farlo uscire dalla gang usa \`/member remove\`.`,
            );
          }
          return target;
        },
      }),

    setRank: (input) =>
      changeRank({
        discordId: input.discordId,
        actorDiscordId: input.actorDiscordId,
        reason: input.reason,
        event: MemberHistoryEvent.RANK_CHANGED,
        action: AuditAction.RANK_CHANGED,
        resolve: () => input.rank,
      }),

    async addSpecialRole(input): Promise<boolean> {
      return memberMutex.run(lockKey('member', input.discordId), async () => {
        const member = await service.requireInGang(input.discordId);
        await requireSnapshot(input.discordId);

        const added = await repos.specialRoles.add(member.id, input.role, input.actorDiscordId);
        // Idempotente: gia' assegnato, nessun duplicato e nessun errore.
        if (!added) return false;

        try {
          await roles.addSpecialRole(input.discordId, input.role, 'Assegnazione ruolo speciale');
        } catch (error) {
          await repos.specialRoles.remove(member.id, input.role, input.actorDiscordId);
          throw error;
        }

        await repos.history.record({
          memberId: member.id,
          discordId: member.discordId,
          event: MemberHistoryEvent.SPECIAL_ROLE_ADDED,
          specialRole: input.role,
          actorDiscordId: input.actorDiscordId,
        });

        await audit.record(
          {
            action: AuditAction.SPECIAL_ROLE_ADDED,
            actorDiscordId: input.actorDiscordId,
            targetDiscordId: input.discordId,
            entityType: 'Member',
            entityId: member.id,
            newValue: input.role,
          },
          ['audit', 'member'],
        );

        return true;
      });
    },

    async removeSpecialRole(input): Promise<boolean> {
      return memberMutex.run(lockKey('member', input.discordId), async () => {
        const member = await service.requireInGang(input.discordId);
        await requireSnapshot(input.discordId);

        const removed = await repos.specialRoles.remove(
          member.id,
          input.role,
          input.actorDiscordId,
        );
        if (!removed) return false;

        try {
          await roles.removeSpecialRole(input.discordId, input.role, 'Rimozione ruolo speciale');
        } catch (error) {
          await repos.specialRoles.add(member.id, input.role, input.actorDiscordId);
          throw error;
        }

        await repos.history.record({
          memberId: member.id,
          discordId: member.discordId,
          event: MemberHistoryEvent.SPECIAL_ROLE_REMOVED,
          specialRole: input.role,
          actorDiscordId: input.actorDiscordId,
        });

        await audit.record(
          {
            action: AuditAction.SPECIAL_ROLE_REMOVED,
            actorDiscordId: input.actorDiscordId,
            targetDiscordId: input.discordId,
            entityType: 'Member',
            entityId: member.id,
            previousValue: input.role,
          },
          ['audit', 'member'],
        );

        return true;
      });
    },

    async listSpecialRoles(memberId: string): Promise<SpecialRole[]> {
      const active = await repos.specialRoles.listActive(memberId);
      return active.map((entry) => entry.role);
    },

    /**
     * Inactive e' puramente additivo: membership, rank, badge e
     * specializzazioni restano tutti al loro posto.
     */
    async setInactive(input): Promise<StatusChangeOutcome> {
      return memberMutex.run(lockKey('member', input.discordId), async () => {
        const member = await service.requireInGang(input.discordId);
        await requireSnapshot(input.discordId);

        if (member.status === MemberStatus.INACTIVE) {
          return { member, changed: false };
        }

        const updated = await repos.members.updateWithVersion(member.id, member.version, {
          status: MemberStatus.INACTIVE,
        });
        if (!updated) {
          throw new ConcurrencyError('Lo stato del membro è cambiato. Riprova.');
        }

        try {
          await roles.setInactive(
            input.discordId,
            input.reason ?? 'Membro impostato come inattivo',
          );
        } catch (error) {
          await compensate(
            member,
            updated.version,
            { status: member.status },
            { operation: 'setInactive' },
          );
          throw error;
        }

        await repos.history.record({
          memberId: member.id,
          discordId: member.discordId,
          event: MemberHistoryEvent.SET_INACTIVE,
          fromStatus: member.status,
          toStatus: MemberStatus.INACTIVE,
          actorDiscordId: input.actorDiscordId,
          reason: input.reason ?? null,
        });

        await audit.record(
          {
            action: AuditAction.SET_INACTIVE,
            actorDiscordId: input.actorDiscordId,
            targetDiscordId: input.discordId,
            entityType: 'Member',
            entityId: member.id,
            previousValue: member.status,
            newValue: MemberStatus.INACTIVE,
            reason: input.reason ?? null,
          },
          ['audit', 'member'],
        );

        return { member: updated, changed: true };
      });
    },

    async setActive(input): Promise<StatusChangeOutcome> {
      return memberMutex.run(lockKey('member', input.discordId), async () => {
        const member = await service.requireInGang(input.discordId);
        await requireSnapshot(input.discordId);

        if (member.status === MemberStatus.ACTIVE) {
          return { member, changed: false };
        }

        const updated = await repos.members.updateWithVersion(member.id, member.version, {
          status: MemberStatus.ACTIVE,
        });
        if (!updated) {
          throw new ConcurrencyError('Lo stato del membro è cambiato. Riprova.');
        }

        try {
          await roles.setActive(input.discordId, input.reason ?? 'Membro riattivato');
        } catch (error) {
          await compensate(
            member,
            updated.version,
            { status: member.status },
            { operation: 'setActive' },
          );
          throw error;
        }

        await repos.history.record({
          memberId: member.id,
          discordId: member.discordId,
          event: MemberHistoryEvent.SET_ACTIVE,
          fromStatus: member.status,
          toStatus: MemberStatus.ACTIVE,
          actorDiscordId: input.actorDiscordId,
          reason: input.reason ?? null,
        });

        await audit.record(
          {
            action: AuditAction.SET_ACTIVE,
            actorDiscordId: input.actorDiscordId,
            targetDiscordId: input.discordId,
            entityType: 'Member',
            entityId: member.id,
            previousValue: member.status,
            newValue: MemberStatus.ACTIVE,
            reason: input.reason ?? null,
          },
          ['audit', 'member'],
        );

        return { member: updated, changed: true };
      });
    },

    /**
     * Uscita dalla gang. NON e' un kick dal Discord e NON cancella nulla:
     * `Verified` resta, lo storico resta, la riga `Member` resta.
     */
    async removeFromGang(input): Promise<RemoveOutcome> {
      return memberMutex.run(lockKey('member', input.discordId), async () => {
        const member = await service.requireInGang(input.discordId);
        const config = await repos.guildConfig.ensure(guildId);

        const updated = await repos.members.updateWithVersion(member.id, member.version, {
          status: MemberStatus.LEFT,
          leftTtpAt: new Date(),
        });
        if (!updated) {
          throw new ConcurrencyError('Lo stato del membro è cambiato. Riprova.');
        }

        const removedSpecialRoles = config.removeSpecialRolesOnLeave
          ? await repos.specialRoles.removeAll(member.id, input.actorDiscordId)
          : [];

        // Il membro potrebbe aver gia' lasciato il Discord: in quel caso la
        // parte a database e' comunque valida e va conservata.
        const snapshot = await gateway.fetchMember(input.discordId);
        if (snapshot) {
          try {
            await roles.removeTtp(input.discordId, input.reason, {
              removeSpecialRoles: config.removeSpecialRolesOnLeave,
            });
          } catch (error) {
            await compensate(
              member,
              updated.version,
              { status: member.status, leftTtpAt: null },
              { operation: 'removeFromGang' },
            );
            throw error;
          }
        }

        await repos.history.record({
          memberId: member.id,
          discordId: member.discordId,
          event: MemberHistoryEvent.LEFT_TTP,
          fromRank: member.rank,
          fromStatus: member.status,
          toStatus: MemberStatus.LEFT,
          actorDiscordId: input.actorDiscordId,
          reason: input.reason,
        });

        await audit.record(
          {
            action: AuditAction.TTP_REMOVED,
            actorDiscordId: input.actorDiscordId,
            targetDiscordId: input.discordId,
            entityType: 'Member',
            entityId: member.id,
            previousValue: member.rank,
            reason: input.reason,
            metadata: {
              verifiedPreserved: true,
              removedSpecialRoles: removedSpecialRoles.map(String),
              stillInGuild: snapshot !== null,
            },
          },
          ['audit', 'member'],
        );

        return { member: updated, removedSpecialRoles };
      });
    },

    /** Permadeath: il personaggio è morto definitivamente. Storico intatto. */
    async permadeath(input): Promise<RemoveOutcome> {
      return memberMutex.run(lockKey('member', input.discordId), async () => {
        const member = await repos.members.findByDiscordId(input.discordId);
        if (!member) {
          throw new AppError(
            ERROR_CODE.NOT_TTP,
            'Questo utente non ha mai fatto parte della gang: non c’è nulla da marcare come permadeath.',
          );
        }
        if (member.status === MemberStatus.PERMADEATH) {
          throw new AppError(
            ERROR_CODE.STATE_CHANGED,
            'Questo membro è già marcato come permadeath.',
          );
        }

        const updated = await repos.members.updateWithVersion(member.id, member.version, {
          status: MemberStatus.PERMADEATH,
          leftTtpAt: new Date(),
        });
        if (!updated) {
          throw new ConcurrencyError('Lo stato del membro è cambiato. Riprova.');
        }

        const removedSpecialRoles = await repos.specialRoles.removeAll(
          member.id,
          input.actorDiscordId,
        );

        const snapshot = await gateway.fetchMember(input.discordId);
        if (snapshot) {
          try {
            await roles.applyPermadeath(input.discordId, input.reason);
          } catch (error) {
            await compensate(
              member,
              updated.version,
              { status: member.status, leftTtpAt: member.leftTtpAt },
              { operation: 'permadeath' },
            );
            throw error;
          }
        }

        await repos.history.record({
          memberId: member.id,
          discordId: member.discordId,
          event: MemberHistoryEvent.PERMADEATH,
          fromRank: member.rank,
          fromStatus: member.status,
          toStatus: MemberStatus.PERMADEATH,
          actorDiscordId: input.actorDiscordId,
          reason: input.reason,
        });

        await audit.record(
          {
            action: AuditAction.PERMADEATH,
            actorDiscordId: input.actorDiscordId,
            targetDiscordId: input.discordId,
            entityType: 'Member',
            entityId: member.id,
            previousValue: member.rank,
            reason: input.reason,
            metadata: { historyPreserved: true },
          },
          ['audit', 'member'],
        );

        return { member: updated, removedSpecialRoles };
      });
    },

    async setNotes(input): Promise<Member> {
      const member = await service.requireInGang(input.discordId);
      const updated = await repos.members.setNotes(member.id, input.notes);
      await audit.record({
        action: AuditAction.MEMBER_NOTES_UPDATED,
        actorDiscordId: input.actorDiscordId,
        targetDiscordId: input.discordId,
        entityType: 'Member',
        entityId: member.id,
        // Il testo delle note non finisce nell'audit: puo' contenere
        // informazioni riservate della Leadership.
        metadata: { notesLength: input.notes?.length ?? 0, cleared: input.notes === null },
      });
      return updated;
    },

    roster: (filter) => repos.members.list(filter),
    counts: () => repos.members.counts(),
  };

  return service;
}
