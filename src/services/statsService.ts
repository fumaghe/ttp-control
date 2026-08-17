/**
 * KPI aggregati mostrati dal control panel.
 */
import type { MemberRank } from '../generated/prisma/enums.js';
import type { Repositories } from '../repositories/types.js';

export interface DashboardStats {
  readonly ttpMembers: number;
  readonly community: number;
  readonly active: number;
  readonly inactive: number;
  readonly pendingApplications: number;
  readonly blacklisted: number;
  readonly permadeath: number;
  readonly left: number;
  readonly byRank: Readonly<Record<MemberRank, number>>;
}

export interface StatsService {
  dashboard(): Promise<DashboardStats>;
}

export function createStatsService(deps: { repos: Repositories }): StatsService {
  const { repos } = deps;

  return {
    async dashboard(): Promise<DashboardStats> {
      const [counts, verified, pendingApplications, blacklisted] = await Promise.all([
        repos.members.counts(),
        repos.verifications.countActive(),
        repos.applications.countPending(),
        repos.blacklist.countActive(),
      ]);

      return {
        ttpMembers: counts.total,
        // "Community" sono i verificati che NON fanno parte della gang.
        community: Math.max(verified - counts.total, 0),
        active: counts.active,
        inactive: counts.inactive,
        pendingApplications,
        blacklisted,
        permadeath: counts.permadeath,
        left: counts.left,
        byRank: counts.byRank,
      };
    },
  };
}
