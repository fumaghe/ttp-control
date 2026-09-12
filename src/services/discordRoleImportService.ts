/**
 * IMPORT Discord → database dei ruoli assegnati a mano dalla UI di Discord.
 *
 * Perché un service dedicato e non `MemberService`: i metodi di `MemberService`
 * scrivono ANCHE su Discord (`setRank` chiama `roles.setHierarchyRank`,
 * `addToGang` chiama `assignTtpWithRank`). Richiamarli dal cron significherebbe
 * riscrivere su Discord ruoli che Discord ha già — nel migliore dei casi una
 * chiamata sprecata, nel peggiore un ping-pong fra cron e comandi. Qui invece
 * vale una regola sola, e non ammette eccezioni:
 *
 *   QUESTO SERVICE NON ASSEGNA E NON RIMUOVE MAI UN RUOLO DISCORD.
 *
 * Discord è già nello stato desiderato: è la sorgente da cui il piano nasce.
 * L'unico effetto è sul database, su `MemberHistory` e sull'audit.
 *
 * DECISIONE E APPLICAZIONE SONO SEPARATE. Il "cosa fare" è `planRoleImport`,
 * puro e testabile senza database. Qui c'è solo il "come scriverlo", con il
 * locking ottimistico e la gestione dei conflitti — che sono problemi di
 * esecuzione, non di dominio.
 *
 * ISOLAMENTO DEGLI ERRORI. Un fallimento non recuperabile viene propagato:
 * il chiamante (la riconciliazione) lo cattura, NON avanza lo snapshot di quel
 * membro e riprova al cron successivo. Uno stato solo ambiguo invece non è un
 * errore: produce un warning, e lo snapshot può avanzare — altrimenti la stessa
 * segnalazione tornerebbe a ogni esecuzione.
 */
import {
  AuditAction,
  MemberHistoryEvent,
  type MemberRank,
  MemberStatus,
  type SpecialRole,
} from '../generated/prisma/enums.js';
import { compareRanks, RANK_LABEL } from '../config/constants.js';
import type { RoleRegistry } from '../config/roles.js';
import { ConcurrencyError } from '../errors/AppError.js';
import type { Member, Repositories, Verification } from '../repositories/types.js';
import { createLogger } from '../utils/logger.js';
import type { AuditChannel, AuditService } from './auditService.js';
import {
  type DatabaseRoleState,
  type DiscordManagedRoleState,
  isInGangStatus,
  planRoleImport,
  readDiscordRoleState,
  type RoleImportAction,
  type RoleImportPlan,
} from './discordRoleState.js';
import type { RankAnnouncementService } from './rankAnnouncementService.js';
import type { GuildMemberSnapshot } from './roleGateway.js';

const log = createLogger('role-import');

/**
 * Da dove nasce l'import. Finisce in `metadata.source` di ogni audit, ed è il
 * solo modo di distinguere a posteriori una modifica manuale da un'adozione
 * massiva al primo avvio.
 */
export type RoleImportSource = 'discord_manual' | 'discord_bootstrap';

/**
 * Contesto di una singola importazione: da dove nasce, e dove finiscono i log.
 *
 * Le due cose viaggiano insieme perché dipendono dalla stessa scelta. Un
 * bootstrap su una guild popolata produce centinaia di modifiche legittime: se
 * ciascuna finisse anche nei canali Discord di audit, il primo cron dopo il
 * deploy scaricherebbe un muro di messaggi su #audit e #member-logs. Il
 * database le registra tutte comunque — è lì che l'audit è autorevole — mentre
 * la copia su Discord serve a chi guarda le modifiche giorno per giorno, e
 * durante l'adozione iniziale non ha destinatario.
 */
interface ImportContext {
  readonly source: RoleImportSource;
  readonly channels: readonly AuditChannel[];
  /** Annunci pubblici Put On / Put Off attivi. Mai durante il bootstrap. */
  readonly announce: boolean;
}

/** Una modifica effettivamente scritta a database. */
export interface ImportedRoleChange {
  readonly kind: RoleImportAction['kind'];
  /** Testo leggibile, per il report del cron. */
  readonly detail: string;
}

export type RoleImportOutcome =
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'imported'; readonly changes: readonly ImportedRoleChange[] }
  | { readonly kind: 'warning'; readonly reasons: readonly string[] }
  | { readonly kind: 'blocked'; readonly reason: string };

export interface RoleImportRequest {
  readonly snapshot: GuildMemberSnapshot;
  /**
   * Adozione iniziale invece di una modifica osservata.
   *
   * Cambia due cose, entrambe di rumore e non di dominio: la `source`
   * nell'audit, e la soppressione degli annunci pubblici Put On / Put Off —
   * un bootstrap su una guild popolata ne pubblicherebbe centinaia.
   */
  readonly bootstrap?: boolean | undefined;
}

export interface DiscordRoleImportService {
  /** Applica a database lo stato Discord di un singolo membro. */
  importMember(request: RoleImportRequest): Promise<RoleImportOutcome>;
  /** Il piano che verrebbe applicato, senza scrivere nulla. */
  planFor(snapshot: GuildMemberSnapshot): Promise<RoleImportPlan>;
  /** Stato a database di un utente, nella forma che le regole sanno leggere. */
  readDatabaseState(discordId: string): Promise<DatabaseRoleState>;
}

export interface DiscordRoleImportDeps {
  readonly repos: Repositories;
  readonly roleRegistry: RoleRegistry;
  readonly audit: AuditService;
  /**
   * Annunci Put On / Put Off. Opzionale: senza, un cambio di rank importato
   * resta comunque valido — l'annuncio non è il dato autorevole.
   */
  readonly announcements?: RankAnnouncementService | undefined;
}

export function createDiscordRoleImportService(
  deps: DiscordRoleImportDeps,
): DiscordRoleImportService {
  const { repos, roleRegistry, audit, announcements } = deps;

  /** Proiezione dello stato a database che le regole sanno leggere. */
  async function readDatabaseState(discordId: string): Promise<DatabaseRoleState> {
    const [member, verification, blacklisted] = await Promise.all([
      repos.members.findByDiscordId(discordId),
      repos.verifications.findActive(discordId),
      repos.blacklist.isBlacklisted(discordId),
    ]);

    const specialRoles =
      member === null
        ? []
        : (await repos.specialRoles.listActive(member.id)).map((entry) => entry.role);

    return {
      member:
        member === null
          ? null
          : {
              id: member.id,
              rank: member.rank,
              status: member.status,
              version: member.version,
            },
      verificationActive: verification !== null,
      blacklisted,
      specialRoles,
    };
  }

  /**
   * Riapplica una mutazione di `Member` con locking ottimistico.
   *
   * Su conflitto NON si riapplica alla cieca: si rilegge lo stato e si guarda
   * se la transizione desiderata è già avvenuta. Se sì l'operazione è
   * completa e non va storicizzata una seconda volta (è il caso di un comando
   * che ha già allineato il database un istante prima); se no il conflitto non
   * è risolvibile in sicurezza e si propaga, così lo snapshot non avanza.
   *
   * @returns il membro aggiornato, oppure `null` se qualcun altro aveva già
   *          applicato esattamente la stessa transizione.
   */
  async function applyVersioned(
    member: Member,
    patch: Parameters<Repositories['members']['updateWithVersion']>[2],
    satisfied: (current: Member) => boolean,
    operation: string,
  ): Promise<Member | null> {
    const updated = await repos.members.updateWithVersion(member.id, member.version, patch);
    if (updated) return updated;

    const current = await repos.members.findByDiscordId(member.discordId);
    if (current && satisfied(current)) {
      log.debug(
        { discordId: member.discordId, operation },
        'Transizione già applicata da un’altra esecuzione: non viene ripetuta',
      );
      return null;
    }

    throw new ConcurrencyError(
      `Conflitto di versione durante l’import di ${operation} per ${member.discordId}: lo snapshot non avanza, si riprova al prossimo cron.`,
    );
  }

  /**
   * Verifica amministrativa importata da un Verified assegnato a mano.
   *
   * Identica per forma a quella di `/community verified`: i dati IC non sono
   * stati raccolti da un modal, quindi `rpName` resta il segnaposto e
   * `oocName` prende il display name osservato su Discord.
   */
  async function importVerification(
    snapshot: GuildMemberSnapshot,
    context: ImportContext,
  ): Promise<Verification | null> {
    await repos.profiles.upsert({
      discordId: snapshot.discordId,
      username: snapshot.username,
      displayName: snapshot.displayName,
    });

    // Ricontrollo dentro l'applicazione: fra il piano e qui può essersi
    // inserita una verifica vera (l'utente ha compilato il modal).
    const existing = await repos.verifications.findActive(snapshot.discordId);
    if (existing) return null;

    const created = await repos.verifications.create({
      discordId: snapshot.discordId,
      rpName: '—',
      oocName: snapshot.displayName,
    });
    await repos.profiles.setVerifiedAt(snapshot.discordId, created.verifiedAt);

    await audit.record(
      {
        action: AuditAction.USER_VERIFIED,
        // L'elenco dei membri della guild non contiene l'autore della modifica:
        // attribuirla a qualcuno sarebbe un'invenzione.
        actorDiscordId: null,
        targetDiscordId: snapshot.discordId,
        entityType: 'Verification',
        entityId: created.id,
        reason: 'Ruolo Verified assegnato manualmente su Discord',
        metadata: {
          source: context.source,
          imported: true,
          rpName: created.rpName,
          oocName: created.oocName,
        },
      },
      context.channels,
    );

    return created;
  }

  /**
   * Crea il `Member` mancante.
   *
   * Una `create` concorrente non è un errore permanente: il vincolo unique su
   * `discordId` è proprio ciò che impedisce il doppione, e la reazione corretta
   * è rileggere la riga esistente e proseguire da quella.
   */
  async function createMember(
    snapshot: GuildMemberSnapshot,
    rank: MemberRank,
  ): Promise<{ member: Member; created: boolean }> {
    await repos.profiles.upsert({
      discordId: snapshot.discordId,
      username: snapshot.username,
      displayName: snapshot.displayName,
    });

    const verification = await repos.verifications.findActive(snapshot.discordId);

    try {
      const member = await repos.members.create({
        discordId: snapshot.discordId,
        rank,
        rpName: verification?.rpName ?? null,
        rpSurname: verification?.rpSurname ?? null,
        citizenId: verification?.citizenId ?? null,
        phone: verification?.phone ?? null,
        recruitedByDiscordId: null,
      });
      return { member, created: true };
    } catch (error) {
      const existing = await repos.members.findByDiscordId(snapshot.discordId);
      if (!existing) throw error;
      log.debug(
        { discordId: snapshot.discordId },
        'Creazione concorrente del membro: si riusa la riga esistente',
      );
      return { member: existing, created: false };
    }
  }

  async function recordMembershipEntry(
    member: Member,
    rank: MemberRank,
    status: MemberStatus,
    context: ImportContext,
    rejoin: boolean,
  ): Promise<void> {
    await repos.history.record({
      memberId: member.id,
      discordId: member.discordId,
      event: MemberHistoryEvent.JOINED_TTP,
      toRank: rank,
      toStatus: status,
      actorDiscordId: null,
      reason: rejoin
        ? 'Rientro rilevato dai ruoli Discord assegnati manualmente'
        : 'Ingresso rilevato dai ruoli Discord assegnati manualmente',
    });

    await audit.record(
      {
        action: AuditAction.TTP_ADDED,
        actorDiscordId: null,
        targetDiscordId: member.discordId,
        entityType: 'Member',
        entityId: member.id,
        newValue: rank,
        reason: 'Ruoli TTP + rank assegnati manualmente su Discord',
        metadata: { source: context.source, imported: true, rejoin, status },
      },
      context.channels,
    );
  }

  /**
   * Applica il piano.
   *
   * `member` viene portato avanti di azione in azione invece di essere riletto
   * ogni volta: ogni `updateWithVersion` restituisce la riga con la versione
   * già incrementata, quindi due mutazioni consecutive sullo stesso membro non
   * si auto-conflittano.
   */
  async function applyPlan(
    snapshot: GuildMemberSnapshot,
    actions: readonly RoleImportAction[],
    context: ImportContext,
  ): Promise<ImportedRoleChange[]> {
    const changes: ImportedRoleChange[] = [];
    let member = await repos.members.findByDiscordId(snapshot.discordId);

    for (const action of actions) {
      switch (action.kind) {
        case 'import-verification': {
          const created = await importVerification(snapshot, context);
          if (created) {
            changes.push({ kind: action.kind, detail: 'Verifica importata da Verified manuale' });
          }
          break;
        }

        case 'create-member': {
          const outcome = await createMember(snapshot, action.rank);
          member = outcome.member;

          if (!outcome.created) {
            // Qualcun altro l'ha creato mentre calcolavamo: non è un ingresso
            // nostro, e il prossimo cron allineerà eventuali differenze.
            break;
          }

          if (action.status === MemberStatus.INACTIVE) {
            // `create` nasce sempre ACTIVE: lo stato d'ingresso si imposta
            // subito dopo, senza storicizzarlo come una transizione — non lo è.
            const paused = await repos.members.updateWithVersion(member.id, member.version, {
              status: MemberStatus.INACTIVE,
            });
            if (paused) member = paused;
          }

          await recordMembershipEntry(member, action.rank, action.status, context, false);
          changes.push({
            kind: action.kind,
            detail: `Nuovo membro ${RANK_LABEL[action.rank]} (${action.status})`,
          });
          break;
        }

        case 'reactivate-member': {
          if (!member) break;
          const updated = await applyVersioned(
            member,
            {
              rank: action.rank,
              status: action.status,
              // Rientro: la data d'ingresso riparte, ma `MemberHistory` non
              // viene toccato — lo storico precedente resta leggibile.
              joinedTtpAt: new Date(),
              leftTtpAt: null,
            },
            (current) => current.rank === action.rank && current.status === action.status,
            'rientro',
          );
          if (!updated) break;

          member = updated;
          await recordMembershipEntry(member, action.rank, action.status, context, true);
          changes.push({
            kind: action.kind,
            detail: `Rientro di un ex membro come ${RANK_LABEL[action.rank]}`,
          });
          break;
        }

        case 'set-rank': {
          if (!member) break;
          const updated = await applyVersioned(
            member,
            { rank: action.to },
            (current) => current.rank === action.to,
            'cambio rank',
          );
          // `null` = il database era già allineato (tipicamente perché un
          // comando ha appena fatto la stessa modifica). Nessuno storico
          // duplicato, nessun audit duplicato, nessun secondo annuncio.
          if (!updated) break;

          member = updated;
          // La direzione si calcola SOLO con RANK_ORDER: mai confrontando i
          // nomi dei rank.
          const promotion = compareRanks(action.to, action.from) > 0;

          await repos.history.record({
            memberId: member.id,
            discordId: member.discordId,
            event: promotion ? MemberHistoryEvent.PROMOTED : MemberHistoryEvent.DEMOTED,
            fromRank: action.from,
            toRank: action.to,
            actorDiscordId: null,
            reason: 'Rank modificato manualmente su Discord',
          });

          await audit.record(
            {
              action: promotion ? AuditAction.PROMOTED : AuditAction.DEMOTED,
              actorDiscordId: null,
              targetDiscordId: member.discordId,
              entityType: 'Member',
              entityId: member.id,
              previousValue: action.from,
              newValue: action.to,
              reason: 'Rank modificato manualmente su Discord',
              metadata: { source: context.source, imported: true },
            },
            context.channels,
          );

          if (context.announce && announcements) {
            // Best-effort e in fondo di proposito: il cambio di rank è già
            // scritto e non viene rimesso in discussione da un canale muto.
            await announcements
              .announceRankChange({
                memberDiscordId: member.discordId,
                // Sconosciuto per costruzione: la lista dei membri della guild
                // non dice CHI ha cambiato il ruolo.
                actorDiscordId: null,
                fromRank: action.from,
                toRank: action.to,
                reason: null,
              })
              .catch((error: unknown) => {
                log.error(
                  { err: error, discordId: snapshot.discordId },
                  'Annuncio Put On/Put Off fallito: il cambio di rank importato resta valido',
                );
              });
          }

          changes.push({
            kind: action.kind,
            detail: `${RANK_LABEL[action.from]} → ${RANK_LABEL[action.to]}`,
          });
          break;
        }

        case 'set-status': {
          if (!member) break;
          const updated = await applyVersioned(
            member,
            { status: action.to },
            (current) => current.status === action.to,
            'cambio stato',
          );
          if (!updated) break;

          member = updated;
          const inactive = action.to === MemberStatus.INACTIVE;

          await repos.history.record({
            memberId: member.id,
            discordId: member.discordId,
            event: inactive ? MemberHistoryEvent.SET_INACTIVE : MemberHistoryEvent.SET_ACTIVE,
            fromStatus: action.from,
            toStatus: action.to,
            actorDiscordId: null,
            reason: inactive
              ? 'Ruolo Inactive assegnato manualmente su Discord'
              : 'Ruolo Inactive rimosso manualmente su Discord',
          });

          await audit.record(
            {
              action: inactive ? AuditAction.SET_INACTIVE : AuditAction.SET_ACTIVE,
              actorDiscordId: null,
              targetDiscordId: member.discordId,
              entityType: 'Member',
              entityId: member.id,
              previousValue: action.from,
              newValue: action.to,
              metadata: { source: context.source, imported: true },
            },
            context.channels,
          );

          changes.push({ kind: action.kind, detail: `${action.from} → ${action.to}` });
          break;
        }

        case 'add-special-role': {
          if (!member) break;
          const added = await addSpecialRole(member, action.role, context);
          if (added) changes.push({ kind: action.kind, detail: `+ ${action.role}` });
          break;
        }

        case 'remove-special-role': {
          if (!member) break;
          const removed = await removeSpecialRole(member, action.role, context);
          if (removed) changes.push({ kind: action.kind, detail: `- ${action.role}` });
          break;
        }

        default: {
          const exhaustive: never = action;
          throw new Error(`Azione di import sconosciuta: ${JSON.stringify(exhaustive)}`);
        }
      }
    }

    return changes;
  }

  /**
   * @returns `false` se il ruolo era già attivo a database: l'operazione è
   *          idempotente e non produce né storico né audit.
   */
  async function addSpecialRole(
    member: Member,
    role: SpecialRole,
    context: ImportContext,
  ): Promise<boolean> {
    // `actorDiscordId` nullo: nessuno ha eseguito un comando, il ruolo è
    // semplicemente comparso su Discord.
    const added = await repos.specialRoles.add(member.id, role, null);
    if (!added) return false;

    await repos.history.record({
      memberId: member.id,
      discordId: member.discordId,
      event: MemberHistoryEvent.SPECIAL_ROLE_ADDED,
      specialRole: role,
      actorDiscordId: null,
      reason: 'Ruolo speciale assegnato manualmente su Discord',
    });

    await audit.record(
      {
        action: AuditAction.SPECIAL_ROLE_ADDED,
        actorDiscordId: null,
        targetDiscordId: member.discordId,
        entityType: 'Member',
        entityId: member.id,
        newValue: role,
        metadata: { source: context.source, imported: true },
      },
      context.channels,
    );

    return true;
  }

  async function removeSpecialRole(
    member: Member,
    role: SpecialRole,
    context: ImportContext,
  ): Promise<boolean> {
    const removed = await repos.specialRoles.remove(member.id, role, null);
    if (!removed) return false;

    await repos.history.record({
      memberId: member.id,
      discordId: member.discordId,
      event: MemberHistoryEvent.SPECIAL_ROLE_REMOVED,
      specialRole: role,
      actorDiscordId: null,
      reason: 'Ruolo speciale rimosso manualmente su Discord',
    });

    await audit.record(
      {
        action: AuditAction.SPECIAL_ROLE_REMOVED,
        actorDiscordId: null,
        targetDiscordId: member.discordId,
        entityType: 'Member',
        entityId: member.id,
        previousValue: role,
        metadata: { source: context.source, imported: true },
      },
      context.channels,
    );

    return true;
  }

  async function stateOf(
    snapshot: GuildMemberSnapshot,
  ): Promise<{ discord: DiscordManagedRoleState; database: DatabaseRoleState }> {
    return {
      discord: readDiscordRoleState(snapshot, roleRegistry),
      database: await readDatabaseState(snapshot.discordId),
    };
  }

  return {
    readDatabaseState,

    async planFor(snapshot: GuildMemberSnapshot): Promise<RoleImportPlan> {
      const { discord, database } = await stateOf(snapshot);
      return planRoleImport(discord, database);
    },

    async importMember(request: RoleImportRequest): Promise<RoleImportOutcome> {
      const { snapshot } = request;
      const bootstrap = request.bootstrap ?? false;
      const context: ImportContext = bootstrap
        ? { source: 'discord_bootstrap', channels: [], announce: false }
        : { source: 'discord_manual', channels: ['audit', 'member'], announce: true };

      const { discord, database } = await stateOf(snapshot);
      const plan = planRoleImport(discord, database);

      switch (plan.kind) {
        case 'unchanged':
          return { kind: 'unchanged' };

        case 'blocked':
          return { kind: 'blocked', reason: plan.issue.detail };

        case 'warning':
          return { kind: 'warning', reasons: plan.issues.map((entry) => entry.detail) };

        case 'actions': {
          const changes = await applyPlan(snapshot, plan.actions, context);
          if (changes.length === 0) return { kind: 'unchanged' };
          return { kind: 'imported', changes };
        }

        default: {
          const exhaustive: never = plan;
          throw new Error(`Piano di import sconosciuto: ${JSON.stringify(exhaustive)}`);
        }
      }
    },
  };
}

/** Il membro a database fa ancora parte della gang. Ri-esportato per comodità. */
export { isInGangStatus };
