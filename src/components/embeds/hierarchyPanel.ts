/**
 * Pannello pubblico della gerarchia Grape.
 *
 * È contenuto testuale, non un embed: Discord non risolve le mention dei ruoli
 * nei titoli dei field di un embed. Nel contenuto normale `<@&id>` diventa il
 * vero tag del ruolo; `allowed_mentions` resta vuoto nel gateway, quindi né
 * ruoli né membri ricevono una notifica.
 */
import { RANK_ORDER } from '../../config/constants.js';
import type { RoleRegistry } from '../../config/roles.js';
import type { MessagePayload } from '../../discord/payload.js';
import type { GuildMemberSnapshotRow } from '../../repositories/types.js';

const MESSAGE_CONTENT_LIMIT = 2000;

interface RankedMember {
  readonly discordId: string;
  readonly nickname: string | null;
  readonly inactive: boolean;
}

interface RankGroup {
  readonly roleId: string;
  readonly members: readonly RankedMember[];
}

function render(groups: readonly RankGroup[], visibleCounts: readonly number[]): string {
  const lines = ['## 🏛️ GERARCHIA GRAPE'];

  groups.forEach((group, index) => {
    const visibleCount = visibleCounts[index] ?? 0;
    const visible = group.members.slice(0, visibleCount);
    const omitted = group.members.length - visible.length;

    lines.push('', `**<@&${group.roleId}> · ${group.members.length}**`);
    if (group.members.length === 0) {
      lines.push('_Nessun membro_');
      return;
    }

    for (const member of visible) {
      lines.push(`• <@${member.discordId}>${member.inactive ? ' 💤' : ''}`);
    }
    if (omitted > 0) lines.push(`…e altri ${omitted}`);
  });

  const uniqueMembers = new Set(groups.flatMap((group) => group.members.map((m) => m.discordId)));
  lines.push('', `**${uniqueMembers.size} membri Grape** · 💤 = inattivo`);
  return lines.join('\n');
}

/**
 * Costruisce un pannello dai ruoli realmente osservati su Discord.
 *
 * Le righe `inGuild=false` restano nello storico degli snapshot per rilevare
 * eventuali rientri, ma non devono comparire nel pannello. Un membro con due
 * rank Discord compare in entrambi: il pannello fotografa i ruoli effettivi e
 * `/system sync-check` continua a segnalare l'ambiguità.
 */
export function buildHierarchyPanel(
  snapshots: readonly GuildMemberSnapshotRow[],
  roles: RoleRegistry,
): MessagePayload {
  const current = snapshots.filter((snapshot) => snapshot.inGuild);
  const groups: RankGroup[] = [...RANK_ORDER].reverse().map((rank) => ({
    roleId: roles.rank[rank],
    members: current
      .filter((snapshot) => snapshot.roleIds.includes(roles.rank[rank]))
      .map((snapshot): RankedMember => ({
        discordId: snapshot.discordId,
        nickname: snapshot.nickname ?? null,
        inactive: snapshot.roleIds.includes(roles.inactive),
      }))
      .sort((left, right) =>
        (left.nickname ?? left.discordId).localeCompare(right.nickname ?? right.discordId, 'it'),
      ),
  }));

  // Mantiene sempre tutti i rank e tronca solo i membri se la guild cresce
  // oltre il limite Discord, senza spezzare mention o produrre JSON invalido.
  const visibleCounts = groups.map((group) => group.members.length);
  let content = render(groups, visibleCounts);
  while (content.length > MESSAGE_CONTENT_LIMIT) {
    let largestGroup = -1;
    for (let index = 0; index < visibleCounts.length; index += 1) {
      if (
        (visibleCounts[index] ?? 0) > 0 &&
        (largestGroup === -1 || (visibleCounts[index] ?? 0) > (visibleCounts[largestGroup] ?? 0))
      ) {
        largestGroup = index;
      }
    }
    if (largestGroup === -1) break;
    visibleCounts[largestGroup] = (visibleCounts[largestGroup] ?? 1) - 1;
    content = render(groups, visibleCounts);
  }

  return { content };
}
