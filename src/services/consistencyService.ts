/**
 * Data consistency: confronta lo stato Discord con lo stato a database.
 *
 * SOLO REPORT. `/system sync-check` non corregge mai nulla, nemmeno con
 * `ROLE_SYNC_MODE=IMPORT_SAFE`: chiamare una diagnostica non deve avere effetti
 * collaterali, e chi la esegue per capire cosa sta succedendo non si aspetta di
 * cambiare lo stato guardandolo.
 *
 * NESSUNA SECONDA IMPLEMENTAZIONE DELLE REGOLE. Le invarianti stanno tutte in
 * `discordRoleState`, e questo service chiede lo STESSO piano che il cron
 * applicherebbe. Da qui viene la proprietà che conta di più: dopo un cron
 * riuscito in `IMPORT_SAFE`, ciò che è stato importato smette di comparire qui,
 * perché il piano che lo descriveva adesso è vuoto. Con due implementazioni
 * separate non ci sarebbe modo di garantirlo.
 *
 * Ogni voce dice anche se il prossimo cron la sistemerà da sé (`importable`) o
 * se serve una persona: è la differenza fra "aspetta cinque minuti" e "qualcuno
 * deve decidere", e un report che non la fa costringe a indovinare.
 */
import { MemberStatus, TtpApplicationStatus } from '../generated/prisma/enums.js';
import { RANK_LABEL } from '../config/constants.js';
import type { RoleSyncMode } from '../config/env.js';
import type { RoleRegistry } from '../config/roles.js';
import type { Repositories } from '../repositories/types.js';
import type { DiscordRoleImportService } from './discordRoleImportService.js';
import {
  describeRoleImportAction,
  type RoleImportAction,
  type RoleStateIssueCode,
  suggestionForAction,
} from './discordRoleState.js';
import type { GuildMemberSnapshot } from './roleGateway.js';

/** Categorie di incoerenza rilevate. */
export type InconsistencyKind =
  | 'TTP_WITHOUT_VERIFIED'
  | 'TTP_WITHOUT_RANK'
  | 'RANK_WITHOUT_TTP'
  | 'MULTIPLE_RANKS'
  | 'MEMBER_DB_WITHOUT_TTP_ROLE'
  | 'TTP_ROLE_WITHOUT_MEMBER_DB'
  | 'RANK_MISMATCH'
  | 'INACTIVE_MISMATCH'
  | 'INACTIVE_WITHOUT_MEMBERSHIP'
  | 'SPECIAL_ROLE_MISMATCH'
  | 'SPECIAL_ROLE_WITHOUT_MEMBERSHIP'
  | 'PERMADEATH_CONFLICT'
  | 'VERIFIED_DB_WITHOUT_ROLE'
  | 'VERIFIED_ROLE_WITHOUT_DB'
  | 'APPROVED_APPLICATION_WITHOUT_MEMBER'
  | 'BLACKLISTED_WITH_ACCESS';

export type Severity = 'warning' | 'error';

export interface Inconsistency {
  readonly kind: InconsistencyKind;
  readonly severity: Severity;
  readonly discordId: string;
  readonly displayName: string;
  readonly detail: string;
  /** Cosa dovrebbe fare l'operatore. Mai eseguito automaticamente. */
  readonly suggestion: string;
  /**
   * Il prossimo cron può sistemarla da solo, se `ROLE_SYNC_MODE=IMPORT_SAFE`.
   *
   * `false` non vuol dire "grave": vuol dire che la decisione richiede un
   * contesto che i ruoli Discord non contengono — una motivazione, un autore,
   * la volontà di far uscire davvero qualcuno dalla gang.
   */
  readonly importable: boolean;
}

export interface ConsistencyReport {
  readonly checkedMembers: number;
  readonly checkedGuildMembers: number;
  readonly validMembers: number;
  readonly issues: readonly Inconsistency[];
  /** Modalità configurata: decide se le voci `importable` verranno risolte. */
  readonly mode: RoleSyncMode;
  /** Quante voci il prossimo cron sistemerebbe da sé in `IMPORT_SAFE`. */
  readonly importableIssues: number;
  readonly generatedAt: Date;
}

export interface ConsistencyService {
  run(): Promise<ConsistencyReport>;
}

const SEVERITY: Record<InconsistencyKind, Severity> = {
  TTP_WITHOUT_VERIFIED: 'error',
  TTP_WITHOUT_RANK: 'error',
  RANK_WITHOUT_TTP: 'error',
  MULTIPLE_RANKS: 'error',
  MEMBER_DB_WITHOUT_TTP_ROLE: 'error',
  TTP_ROLE_WITHOUT_MEMBER_DB: 'error',
  RANK_MISMATCH: 'error',
  INACTIVE_MISMATCH: 'warning',
  INACTIVE_WITHOUT_MEMBERSHIP: 'warning',
  SPECIAL_ROLE_MISMATCH: 'warning',
  SPECIAL_ROLE_WITHOUT_MEMBERSHIP: 'warning',
  PERMADEATH_CONFLICT: 'error',
  VERIFIED_DB_WITHOUT_ROLE: 'warning',
  VERIFIED_ROLE_WITHOUT_DB: 'warning',
  APPROVED_APPLICATION_WITHOUT_MEMBER: 'error',
  BLACKLISTED_WITH_ACCESS: 'error',
};

/**
 * Violazione di invariante → categoria del report.
 *
 * Due codici conservano di proposito il nome storico invece del proprio:
 * `TTP_REMOVED_FROM_MEMBER` è esattamente la condizione che il report chiamava
 * `MEMBER_DB_WITHOUT_TTP_ROLE`, e `VERIFIED_REMOVED` quella che chiamava
 * `VERIFIED_DB_WITHOUT_ROLE`. Rinominarle avrebbe cambiato un'etichetta che
 * l'operatore riconosce, senza cambiare nulla di ciò che descrive.
 */
const ISSUE_KIND: Record<RoleStateIssueCode, InconsistencyKind> = {
  TTP_WITHOUT_VERIFIED: 'TTP_WITHOUT_VERIFIED',
  TTP_WITHOUT_RANK: 'TTP_WITHOUT_RANK',
  MULTIPLE_RANKS: 'MULTIPLE_RANKS',
  RANK_WITHOUT_TTP: 'RANK_WITHOUT_TTP',
  INACTIVE_WITHOUT_MEMBERSHIP: 'INACTIVE_WITHOUT_MEMBERSHIP',
  SPECIAL_ROLE_WITHOUT_MEMBERSHIP: 'SPECIAL_ROLE_WITHOUT_MEMBERSHIP',
  BLACKLISTED_WITH_ACCESS: 'BLACKLISTED_WITH_ACCESS',
  PERMADEATH_WITH_MEMBERSHIP_ROLES: 'PERMADEATH_CONFLICT',
  PERMADEATH_MEMBER_REASSIGNED: 'PERMADEATH_CONFLICT',
  TTP_REMOVED_FROM_MEMBER: 'MEMBER_DB_WITHOUT_TTP_ROLE',
  VERIFIED_REMOVED: 'VERIFIED_DB_WITHOUT_ROLE',
};

/** Transizione importabile → categoria del report. */
function actionKind(action: RoleImportAction): InconsistencyKind {
  switch (action.kind) {
    case 'import-verification':
      return 'VERIFIED_ROLE_WITHOUT_DB';
    case 'create-member':
    case 'reactivate-member':
      return 'TTP_ROLE_WITHOUT_MEMBER_DB';
    case 'set-rank':
      return 'RANK_MISMATCH';
    case 'set-status':
      return 'INACTIVE_MISMATCH';
    case 'add-special-role':
    case 'remove-special-role':
      return 'SPECIAL_ROLE_MISMATCH';
    default: {
      const exhaustive: never = action;
      throw new Error(`Azione di import sconosciuta: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export function createConsistencyService(deps: {
  repos: Repositories;
  roleRegistry: RoleRegistry;
  /** Sorgente unica delle regole: le stesse che il cron applicherebbe. */
  roleImport: DiscordRoleImportService;
  /** Modalità configurata. Non cambia cosa si rileva, solo cosa si consiglia. */
  mode?: RoleSyncMode | undefined;
  /** Tutti i membri della guild, con i ruoli gia' risolti. */
  listAllGuildMembers: () => Promise<GuildMemberSnapshot[]>;
}): ConsistencyService {
  const { repos, roleImport } = deps;
  const mode: RoleSyncMode = deps.mode ?? 'REPORT_ONLY';

  return {
    async run(): Promise<ConsistencyReport> {
      const issues: Inconsistency[] = [];

      const add = (
        kind: InconsistencyKind,
        discordId: string,
        displayName: string,
        detail: string,
        suggestion: string,
        importable: boolean,
      ): void => {
        issues.push({
          kind,
          severity: SEVERITY[kind],
          discordId,
          displayName,
          detail,
          suggestion,
          importable,
        });
      };

      const [snapshots, dbMembers] = await Promise.all([
        deps.listAllGuildMembers(),
        repos.members.list(),
      ]);

      const snapshotById = new Map(snapshots.map((s) => [s.discordId, s]));
      const memberById = new Map(dbMembers.map((m) => [m.discordId, m]));

      const inGangIds = new Set(
        dbMembers
          .filter((m) => m.status === MemberStatus.ACTIVE || m.status === MemberStatus.INACTIVE)
          .map((m) => m.discordId),
      );

      let validMembers = 0;

      // ------------------------------------------------------------------
      // 1. Dal lato Discord: si chiede al motore di import cosa farebbe.
      // ------------------------------------------------------------------
      for (const snapshot of snapshots) {
        const { discordId, displayName } = snapshot;
        const plan = await roleImport.planFor(snapshot);
        let clean = true;

        switch (plan.kind) {
          case 'unchanged':
            break;

          case 'blocked': {
            clean = false;
            const kind = ISSUE_KIND[plan.issue.code];
            // Bloccato da un fatto autorevole a database: nessun cron lo
            // risolverà, per quanto si aspetti.
            add(kind, discordId, displayName, plan.issue.detail, plan.issue.suggestion, false);
            break;
          }

          case 'warning':
            clean = false;
            for (const issue of plan.issues) {
              add(
                ISSUE_KIND[issue.code],
                discordId,
                displayName,
                issue.detail,
                issue.suggestion,
                false,
              );
            }
            break;

          case 'actions':
            clean = false;
            for (const action of plan.actions) {
              add(
                actionKind(action),
                discordId,
                displayName,
                describeRoleImportAction(action),
                mode === 'IMPORT_SAFE'
                  ? 'Nessun intervento necessario: il prossimo cron la importa da solo.'
                  : suggestionForAction(action),
                true,
              );
            }
            break;

          default: {
            const exhaustive: never = plan;
            throw new Error(`Piano di import sconosciuto: ${JSON.stringify(exhaustive)}`);
          }
        }

        if (clean && inGangIds.has(discordId)) validMembers += 1;
      }

      // ------------------------------------------------------------------
      // 2. Dal lato database: membri che non sono piu' nella guild.
      //    Non e' una divergenza di ruoli — non ci sono piu' ruoli da leggere —
      //    quindi il motore di import non la vede e va cercata da questa parte.
      // ------------------------------------------------------------------
      for (const member of dbMembers) {
        if (member.status !== MemberStatus.ACTIVE && member.status !== MemberStatus.INACTIVE) {
          continue;
        }
        if (snapshotById.has(member.discordId)) continue;

        add(
          'MEMBER_DB_WITHOUT_TTP_ROLE',
          member.discordId,
          `<@${member.discordId}>`,
          `Risulta membro attivo (${RANK_LABEL[member.rank]}) a database ma non è più nel server Discord.`,
          'Registra l’uscita con `/member remove` se ha davvero lasciato la gang.',
          // Uscire dal Discord NON è lasciare la gang: nessun automatismo.
          false,
        );
      }

      // ------------------------------------------------------------------
      // 3. Candidature approvate senza il corrispondente Member.
      // ------------------------------------------------------------------
      const allApplications = await Promise.all(
        [...new Set(dbMembers.map((m) => m.discordId))].map((id) =>
          repos.applications.listByDiscordId(id),
        ),
      );
      const approvedWithMember = new Set(
        allApplications
          .flat()
          .filter((app) => app.status === TtpApplicationStatus.APPROVED)
          .map((app) => app.discordId),
      );

      for (const snapshot of snapshots) {
        if (memberById.has(snapshot.discordId)) continue;
        const applications = await repos.applications.listByDiscordId(snapshot.discordId);
        const approved = applications.find((app) => app.status === TtpApplicationStatus.APPROVED);
        if (approved && !approvedWithMember.has(snapshot.discordId)) {
          add(
            'APPROVED_APPLICATION_WITHOUT_MEMBER',
            snapshot.discordId,
            snapshot.displayName,
            'Ha una candidatura APPROVED ma non esiste nessun record Member.',
            'Completa l’ingresso con `/member add`.',
            false,
          );
        }
      }

      return {
        checkedMembers: dbMembers.length,
        checkedGuildMembers: snapshots.length,
        validMembers,
        issues,
        mode,
        importableIssues: issues.filter((issue) => issue.importable).length,
        generatedAt: new Date(),
      };
    },
  };
}
