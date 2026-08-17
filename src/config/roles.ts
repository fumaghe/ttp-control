/**
 * Registry dei ruoli Discord.
 *
 * Ogni ruolo appartiene a UNA dimensione (membership, rank, community, status,
 * badge, specializzazione): non vanno mai mescolate.
 *
 * I ruoli si identificano SEMPRE per ID, mai per nome.
 */
import { MemberRank, SpecialRole } from '../generated/prisma/enums.js';
import { type Env } from './env.js';
import { RANK_ORDER } from './constants.js';

export type RoleDimension =
  'membership' | 'rank' | 'community' | 'status' | 'badge' | 'specialization';

export interface RoleDescriptor {
  readonly key: string;
  readonly id: string;
  readonly label: string;
  readonly dimension: RoleDimension;
}

export interface RoleRegistry {
  /** `✅ Verified` — ha completato la verifica. NON implica membership TTP. */
  readonly verified: string;
  /** `🩸 TTP` — membro effettivo della gang. */
  readonly ttp: string;

  /** ID del ruolo Discord per ogni rank della gerarchia. */
  readonly rank: Readonly<Record<MemberRank, string>>;
  /** ID del ruolo Discord per ogni ruolo speciale gestito da `/member roles`. */
  readonly special: Readonly<Record<SpecialRole, string>>;

  readonly friend: string;
  readonly mafia: string;

  readonly banned: string;
  readonly inactive: string;
  readonly permadeath: string;

  /** Tutti i ruoli descritti, per il system check di `/setup`. */
  readonly all: readonly RoleDescriptor[];

  /** Ruoli che il bot deve poter assegnare/rimuovere (verifica gerarchia). */
  readonly managed: readonly RoleDescriptor[];

  rankFromRoleId(roleId: string): MemberRank | undefined;
  specialFromRoleId(roleId: string): SpecialRole | undefined;
  /** Tutti gli ID dei ruoli rank, nell'ordine della gerarchia. */
  readonly allRankIds: readonly string[];
  readonly allSpecialIds: readonly string[];
}

export function buildRoleRegistry(env: Env): RoleRegistry {
  const r = env.roles;

  const rank: Record<MemberRank, string> = {
    [MemberRank.RESIDENT]: r.resident,
    [MemberRank.GANGSTER]: r.gangster,
    [MemberRank.YOUNG_OG]: r.youngOg,
    [MemberRank.BIG]: r.big,
    [MemberRank.OG]: r.og,
  };

  const special: Record<SpecialRole, string> = {
    [SpecialRole.SHOOTER]: r.shooter,
    [SpecialRole.MAIN_SHOOTER]: r.mainShooter,
    [SpecialRole.HONOR_1]: r.honor1,
    [SpecialRole.HONOR_2]: r.honor2,
    [SpecialRole.SUPPORTER]: r.supporter,
    [SpecialRole.FIRST_DAY]: r.firstDay,
  };

  const all: RoleDescriptor[] = [
    { key: 'verified', id: r.verified, label: '✅ Verified', dimension: 'membership' },
    { key: 'ttp', id: r.ttp, label: '🩸 TTP', dimension: 'membership' },

    { key: 'resident', id: r.resident, label: '🏠 Resident', dimension: 'rank' },
    { key: 'gangster', id: r.gangster, label: '🥷 Gangster', dimension: 'rank' },
    { key: 'youngOg', id: r.youngOg, label: '🩸 Young OG', dimension: 'rank' },
    { key: 'big', id: r.big, label: '💎 Big', dimension: 'rank' },
    { key: 'og', id: r.og, label: '👑 OG', dimension: 'rank' },

    { key: 'friend', id: r.friend, label: '🤝 Friend', dimension: 'community' },
    { key: 'mafia', id: r.mafia, label: '🕴 Mafia', dimension: 'community' },

    { key: 'banned', id: r.banned, label: '⛔ Banned', dimension: 'status' },
    { key: 'inactive', id: r.inactive, label: '💤 Inactive', dimension: 'status' },
    { key: 'permadeath', id: r.permadeath, label: '💀 Permadeath', dimension: 'status' },

    { key: 'honor1', id: r.honor1, label: '🎖 Honor 1', dimension: 'badge' },
    { key: 'honor2', id: r.honor2, label: '🏅 Honor 2', dimension: 'badge' },
    { key: 'supporter', id: r.supporter, label: '💗 Supporter', dimension: 'badge' },
    { key: 'firstDay', id: r.firstDay, label: '🥇 First Day', dimension: 'badge' },

    { key: 'shooter', id: r.shooter, label: '🎯 Shooter', dimension: 'specialization' },
    {
      key: 'mainShooter',
      id: r.mainShooter,
      label: '👑 Main Shooter',
      dimension: 'specialization',
    },
  ];

  // Il bot non gestisce `Banned`: quello resta un'azione manuale dello staff.
  const managed = all.filter((d) => d.key !== 'banned');

  const rankByRoleId = new Map<string, MemberRank>(
    (Object.entries(rank) as [MemberRank, string][]).map(([k, v]) => [v, k]),
  );
  const specialByRoleId = new Map<string, SpecialRole>(
    (Object.entries(special) as [SpecialRole, string][]).map(([k, v]) => [v, k]),
  );

  return {
    verified: r.verified,
    ttp: r.ttp,
    rank,
    special,
    friend: r.friend,
    mafia: r.mafia,
    banned: r.banned,
    inactive: r.inactive,
    permadeath: r.permadeath,
    all,
    managed,
    rankFromRoleId: (roleId) => rankByRoleId.get(roleId),
    specialFromRoleId: (roleId) => specialByRoleId.get(roleId),
    allRankIds: RANK_ORDER.map((name) => rank[name]),
    allSpecialIds: Object.values(special),
  };
}
