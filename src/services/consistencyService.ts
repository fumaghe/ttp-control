/**
 * Data consistency: confronta lo stato Discord con lo stato a database.
 *
 * SOLO REPORT. Nessuna correzione automatica: una "riparazione" sbagliata su
 * dati di membership fa piu' danni dell'incoerenza che vorrebbe risolvere.
 * L'output serve a un operatore per decidere.
 */
import { MemberStatus, TtpApplicationStatus } from '../generated/prisma/enums.js';
import { RANK_LABEL } from '../config/constants.js';
import type { RoleRegistry } from '../config/roles.js';
import type { Repositories } from '../repositories/types.js';
import type { RoleService } from './roleService.js';
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
  | 'SPECIAL_ROLE_MISMATCH'
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
}

export interface ConsistencyReport {
  readonly checkedMembers: number;
  readonly checkedGuildMembers: number;
  readonly validMembers: number;
  readonly issues: readonly Inconsistency[];
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
  SPECIAL_ROLE_MISMATCH: 'warning',
  VERIFIED_DB_WITHOUT_ROLE: 'warning',
  VERIFIED_ROLE_WITHOUT_DB: 'warning',
  APPROVED_APPLICATION_WITHOUT_MEMBER: 'error',
  BLACKLISTED_WITH_ACCESS: 'error',
};

export function createConsistencyService(deps: {
  repos: Repositories;
  roles: RoleService;
  roleRegistry: RoleRegistry;
  /** Tutti i membri della guild, con i ruoli gia' risolti. */
  listAllGuildMembers: () => Promise<GuildMemberSnapshot[]>;
}): ConsistencyService {
  const { repos, roles, roleRegistry } = deps;

  return {
    async run(): Promise<ConsistencyReport> {
      const issues: Inconsistency[] = [];
      const add = (
        kind: InconsistencyKind,
        discordId: string,
        displayName: string,
        detail: string,
        suggestion: string,
      ): void => {
        issues.push({ kind, severity: SEVERITY[kind], discordId, displayName, detail, suggestion });
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
      // 1. Dal lato Discord: cosa dicono i ruoli.
      // ------------------------------------------------------------------
      for (const snapshot of snapshots) {
        const { discordId, displayName } = snapshot;
        const isTtp = roles.isTtp(snapshot);
        const isVerified = roles.isVerified(snapshot);
        const ranks = roles.readAllRanks(snapshot);
        const member = memberById.get(discordId);
        const inGang = inGangIds.has(discordId);
        let clean = true;

        // TTP ⇒ Verified
        if (isTtp && !isVerified) {
          clean = false;
          add(
            'TTP_WITHOUT_VERIFIED',
            discordId,
            displayName,
            'Ha il ruolo TTP ma non Verified.',
            'Assegna Verified con `/community verified`: `TTP ⇒ Verified` è un’invariante.',
          );
        }

        // Esattamente un rank
        if (isTtp && ranks.length === 0) {
          clean = false;
          add(
            'TTP_WITHOUT_RANK',
            discordId,
            displayName,
            'Ha il ruolo TTP ma nessun rank della gerarchia.',
            'Assegna un rank con `/member rank`.',
          );
        }
        if (ranks.length > 1) {
          clean = false;
          add(
            'MULTIPLE_RANKS',
            discordId,
            displayName,
            `Ha ${ranks.length} rank contemporaneamente: ${ranks.map((r) => RANK_LABEL[r]).join(' + ')}.`,
            'Usa `/member rank` per riportarlo a un rank unico.',
          );
        }
        if (!isTtp && ranks.length > 0) {
          clean = false;
          add(
            'RANK_WITHOUT_TTP',
            discordId,
            displayName,
            `Ha un rank (${ranks.map((r) => RANK_LABEL[r]).join(', ')}) senza il ruolo TTP.`,
            'Rimuovi il rank a mano oppure regolarizza la membership con `/member add`.',
          );
        }

        // Discord ↔ database
        if (isTtp && !inGang) {
          clean = false;
          add(
            'TTP_ROLE_WITHOUT_MEMBER_DB',
            discordId,
            displayName,
            member
              ? `Ha il ruolo TTP ma a database risulta **${member.status}**.`
              : 'Ha il ruolo TTP ma non esiste nessun record Member.',
            'Regolarizza con `/member add`, oppure rimuovi il ruolo se non è più un membro.',
          );
        }
        if (!isTtp && inGang) {
          clean = false;
          add(
            'MEMBER_DB_WITHOUT_TTP_ROLE',
            discordId,
            displayName,
            'Risulta membro a database ma non ha il ruolo TTP su Discord.',
            'Riassegna i ruoli con `/member add`, oppure registra l’uscita con `/member remove`.',
          );
        }

        const soleRank = ranks.length === 1 ? ranks[0] : undefined;
        if (member && inGang && soleRank !== undefined && soleRank !== member.rank) {
          clean = false;
          add(
            'RANK_MISMATCH',
            discordId,
            displayName,
            `Discord dice ${RANK_LABEL[soleRank]}, il database dice ${RANK_LABEL[member.rank]}.`,
            'Allinea con `/member rank`.',
          );
        }

        // Inactive
        const hasInactiveRole = snapshot.roleIds.has(roleRegistry.inactive);
        if (member && inGang) {
          const shouldBeInactive = member.status === MemberStatus.INACTIVE;
          if (shouldBeInactive !== hasInactiveRole) {
            clean = false;
            add(
              'INACTIVE_MISMATCH',
              discordId,
              displayName,
              shouldBeInactive
                ? 'È INACTIVE a database ma non ha il ruolo Inactive su Discord.'
                : 'Ha il ruolo Inactive su Discord ma a database è ACTIVE.',
              'Allinea con `/member inactive` oppure `/member active`.',
            );
          }
        }

        // Ruoli speciali
        if (member) {
          const discordSpecials = new Set(roles.readSpecialRoles(snapshot));
          const dbSpecials = new Set(
            (await repos.specialRoles.listActive(member.id)).map((entry) => entry.role),
          );
          const onlyDiscord = [...discordSpecials].filter((r) => !dbSpecials.has(r));
          const onlyDb = [...dbSpecials].filter((r) => !discordSpecials.has(r));
          if (onlyDiscord.length > 0 || onlyDb.length > 0) {
            clean = false;
            add(
              'SPECIAL_ROLE_MISMATCH',
              discordId,
              displayName,
              [
                onlyDiscord.length > 0 ? `Solo su Discord: ${onlyDiscord.join(', ')}` : '',
                onlyDb.length > 0 ? `Solo a database: ${onlyDb.join(', ')}` : '',
              ]
                .filter(Boolean)
                .join(' · '),
              'Allinea con `/member roles`.',
            );
          }
        }

        // Verified ↔ database
        const verification = await repos.verifications.findActive(discordId);
        if (isVerified && !verification) {
          clean = false;
          add(
            'VERIFIED_ROLE_WITHOUT_DB',
            discordId,
            displayName,
            'Ha il ruolo Verified ma non esiste una verifica attiva a database.',
            'Fagli rifare la verifica, oppure registrala con `/community verified`.',
          );
        }
        if (!isVerified && verification) {
          clean = false;
          add(
            'VERIFIED_DB_WITHOUT_ROLE',
            discordId,
            displayName,
            'Ha una verifica attiva a database ma non il ruolo Verified.',
            'Riassegna il ruolo con `/community verified`.',
          );
        }

        // Blacklist con accesso ancora attivo
        if (await repos.blacklist.isBlacklisted(discordId)) {
          if (isVerified || isTtp) {
            clean = false;
            add(
              'BLACKLISTED_WITH_ACCESS',
              discordId,
              displayName,
              'È in blacklist ma conserva Verified e/o TTP.',
              'Revoca l’accesso con `/community revoke`.',
            );
          }
        }

        if (clean && inGang) validMembers += 1;
      }

      // ------------------------------------------------------------------
      // 2. Dal lato database: membri che non sono piu' nella guild.
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
          'Risulta membro attivo a database ma non è più nel server Discord.',
          'Registra l’uscita con `/member remove` se ha davvero lasciato la gang.',
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
          );
        }
      }

      return {
        checkedMembers: dbMembers.length,
        checkedGuildMembers: snapshots.length,
        validMembers,
        issues,
        generatedAt: new Date(),
      };
    },
  };
}
