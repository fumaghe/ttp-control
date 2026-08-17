/**
 * Gestione centralizzata dei ruoli Discord.
 *
 * Nessun altro modulo deve chiamare `roles.add` / `roles.remove`: qui sta la
 * logica che garantisce le invarianti di dominio, in particolare
 * "esattamente un rank per membro TTP".
 *
 * Tutte le mutazioni passano da `applyRoleDiff`, che esegue una sola chiamata
 * all'API Discord: mai uno stato intermedio in cui il membro ha zero o due
 * rank.
 */
import type { MemberRank, SpecialRole } from '../generated/prisma/enums.js';
import type { RoleRegistry } from '../config/roles.js';
import type { GuildMemberSnapshot, RoleGateway } from './roleGateway.js';

export interface RoleService {
  /** `✅ Verified`. Non tocca MAI la membership TTP. */
  assignVerified(discordId: string, reason: string): Promise<GuildMemberSnapshot>;
  removeVerified(discordId: string, reason: string): Promise<GuildMemberSnapshot>;

  /**
   * Entrata nella gang: `🩸 TTP` + esattamente un rank, in un'unica
   * operazione. Verified viene aggiunto se mancante, perche' `TTP ⇒ Verified`.
   */
  assignTtpWithRank(
    discordId: string,
    rank: MemberRank,
    reason: string,
  ): Promise<GuildMemberSnapshot>;

  /**
   * Uscita dalla gang: rimuove TTP, tutti i rank e (se richiesto) i ruoli
   * speciali. Verified viene SEMPRE preservato.
   */
  removeTtp(
    discordId: string,
    reason: string,
    options?: { removeSpecialRoles?: boolean },
  ): Promise<GuildMemberSnapshot>;

  /** Sostituisce il rank corrente, garantendo che ne resti esattamente uno. */
  setHierarchyRank(
    discordId: string,
    rank: MemberRank,
    reason: string,
  ): Promise<GuildMemberSnapshot>;

  addSpecialRole(
    discordId: string,
    role: SpecialRole,
    reason: string,
  ): Promise<GuildMemberSnapshot>;
  removeSpecialRole(
    discordId: string,
    role: SpecialRole,
    reason: string,
  ): Promise<GuildMemberSnapshot>;

  setInactive(discordId: string, reason: string): Promise<GuildMemberSnapshot>;
  setActive(discordId: string, reason: string): Promise<GuildMemberSnapshot>;

  /** Permadeath: via TTP e rank, resta il marchio `💀 Permadeath`. */
  applyPermadeath(discordId: string, reason: string): Promise<GuildMemberSnapshot>;

  assignCommunityRole(
    discordId: string,
    which: 'friend' | 'mafia',
    reason: string,
  ): Promise<GuildMemberSnapshot>;
  removeCommunityRole(
    discordId: string,
    which: 'friend' | 'mafia',
    reason: string,
  ): Promise<GuildMemberSnapshot>;
  /** Revoca l'accesso community: Verified + Friend + Mafia. */
  revokeCommunityAccess(discordId: string, reason: string): Promise<GuildMemberSnapshot>;

  /** Rank desumibile dai ruoli Discord posseduti. */
  readRank(snapshot: GuildMemberSnapshot): MemberRank | undefined;
  /** Tutti i rank posseduti: piu' di uno e' un'inconsistenza da segnalare. */
  readAllRanks(snapshot: GuildMemberSnapshot): MemberRank[];
  readSpecialRoles(snapshot: GuildMemberSnapshot): SpecialRole[];
  isVerified(snapshot: GuildMemberSnapshot): boolean;
  isTtp(snapshot: GuildMemberSnapshot): boolean;
}

export function createRoleService(deps: {
  roles: RoleRegistry;
  gateway: RoleGateway;
}): RoleService {
  const { roles, gateway } = deps;

  const service: RoleService = {
    async assignVerified(discordId, reason) {
      return gateway.applyRoleDiff(discordId, { add: [roles.verified] }, reason);
    },

    async removeVerified(discordId, reason) {
      return gateway.applyRoleDiff(discordId, { remove: [roles.verified] }, reason);
    },

    async assignTtpWithRank(discordId, rank, reason) {
      // `TTP ⇒ Verified`: se per qualche motivo manca, lo aggiungiamo qui
      // invece di creare uno stato che il sync-check segnalerebbe.
      const add = [roles.verified, roles.ttp, roles.rank[rank]];
      // Via ogni altro rank: l'invariante e' "esattamente uno".
      const remove = roles.allRankIds.filter((id) => id !== roles.rank[rank]);
      return gateway.applyRoleDiff(discordId, { add, remove }, reason);
    },

    async removeTtp(discordId, reason, options) {
      const remove = [roles.ttp, ...roles.allRankIds, roles.inactive];
      if (options?.removeSpecialRoles ?? false) remove.push(...roles.allSpecialIds);
      // Verified NON e' nella lista: restare Verified dopo l'uscita dalla
      // gang e' una regola di dominio, non un dettaglio.
      return gateway.applyRoleDiff(discordId, { remove }, reason);
    },

    async setHierarchyRank(discordId, rank, reason) {
      const target = roles.rank[rank];
      return gateway.applyRoleDiff(
        discordId,
        { add: [target], remove: roles.allRankIds.filter((id) => id !== target) },
        reason,
      );
    },

    async addSpecialRole(discordId, role, reason) {
      return gateway.applyRoleDiff(discordId, { add: [roles.special[role]] }, reason);
    },

    async removeSpecialRole(discordId, role, reason) {
      return gateway.applyRoleDiff(discordId, { remove: [roles.special[role]] }, reason);
    },

    async setInactive(discordId, reason) {
      // Inactive e' additivo: rank, badge e membership restano intatti.
      return gateway.applyRoleDiff(discordId, { add: [roles.inactive] }, reason);
    },

    async setActive(discordId, reason) {
      return gateway.applyRoleDiff(discordId, { remove: [roles.inactive] }, reason);
    },

    async applyPermadeath(discordId, reason) {
      return gateway.applyRoleDiff(
        discordId,
        {
          add: [roles.permadeath],
          remove: [roles.ttp, ...roles.allRankIds, roles.inactive],
        },
        reason,
      );
    },

    async assignCommunityRole(discordId, which, reason) {
      return gateway.applyRoleDiff(discordId, { add: [roles[which]] }, reason);
    },

    async removeCommunityRole(discordId, which, reason) {
      return gateway.applyRoleDiff(discordId, { remove: [roles[which]] }, reason);
    },

    async revokeCommunityAccess(discordId, reason) {
      return gateway.applyRoleDiff(
        discordId,
        { remove: [roles.verified, roles.friend, roles.mafia] },
        reason,
      );
    },

    readAllRanks(snapshot) {
      const found: MemberRank[] = [];
      for (const roleId of roles.allRankIds) {
        if (!snapshot.roleIds.has(roleId)) continue;
        const rank = roles.rankFromRoleId(roleId);
        if (rank) found.push(rank);
      }
      return found;
    },

    readRank(snapshot) {
      // Con piu' rank presenti (stato anomalo) prendiamo il piu' alto:
      // `allRankIds` e' in ordine crescente, quindi e' l'ultimo trovato.
      return service.readAllRanks(snapshot).at(-1);
    },

    readSpecialRoles(snapshot) {
      const found: SpecialRole[] = [];
      for (const roleId of roles.allSpecialIds) {
        if (!snapshot.roleIds.has(roleId)) continue;
        const role = roles.specialFromRoleId(roleId);
        if (role) found.push(role);
      }
      return found;
    },

    isVerified: (snapshot) => snapshot.roleIds.has(roles.verified),
    isTtp: (snapshot) => snapshot.roleIds.has(roles.ttp),
  };

  return service;
}
