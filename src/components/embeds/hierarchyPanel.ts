/**
 * Pannello pubblico della gerarchia TTP.
 *
 * È un solo messaggio persistente: il cron lo modifica ogni cinque minuti
 * invece di pubblicarne uno nuovo. I membri provengono dal roster a database,
 * quindi il pannello segue lo stesso stato mostrato dal Management System.
 */
import { MemberStatus } from '../../generated/prisma/enums.js';
import { RANK_ORDER } from '../../config/constants.js';
import type { RoleRegistry } from '../../config/roles.js';
import type { MessagePayload } from '../../discord/payload.js';
import type { Member } from '../../repositories/types.js';
import { brandEmbed } from './base.js';

/**
 * Nove field da 600 caratteri restano sotto il limite totale di 6000
 * caratteri imposto da Discord, inclusi titolo, descrizione e footer.
 */
const MAX_MEMBERS_FIELD_LENGTH = 600;

function memberLabel(member: Member): string {
  const inactive = member.status === MemberStatus.INACTIVE ? ' 💤' : '';
  return `• <@${member.discordId}>${inactive}`;
}

/** Tronca esplicitamente un gruppo molto grande, senza spezzare una mention. */
function memberList(members: readonly Member[]): string {
  if (members.length === 0) return '_Nessun membro_';

  const lines: string[] = [];
  for (let index = 0; index < members.length; index += 1) {
    const member = members[index];
    if (!member) break;
    const line = memberLabel(member);
    const remaining = members.length - index - 1;
    const suffix = remaining > 0 ? `\n…e altri ${remaining}` : '';
    const candidate = [...lines, line].join('\n');

    if (`${candidate}${suffix}`.length > MAX_MEMBERS_FIELD_LENGTH) {
      lines.push(`…e altri ${members.length - index}`);
      break;
    }
    lines.push(line);
  }

  return lines.join('\n');
}

export function buildHierarchyPanel(
  members: readonly Member[],
  roles: RoleRegistry,
): MessagePayload {
  const current = members.filter(
    (member) => member.status === MemberStatus.ACTIVE || member.status === MemberStatus.INACTIVE,
  );

  const embed = brandEmbed('🏛️ GERARCHIA TTP')
    .setDescription(
      'Membri raggruppati per ruolo gerarchico. Il pannello si aggiorna automaticamente ogni 5 minuti.',
    )
    .setFooter({ text: `${current.length} membri TTP · 💤 = inattivo` });

  for (const rank of [...RANK_ORDER].reverse()) {
    const group = current
      .filter((member) => member.rank === rank)
      .sort((left, right) => {
        const leftName = [left.rpName, left.rpSurname].filter(Boolean).join(' ');
        const rightName = [right.rpName, right.rpSurname].filter(Boolean).join(' ');
        return (leftName || left.discordId).localeCompare(rightName || right.discordId, 'it');
      });

    embed.addFields({
      name: `<@&${roles.rank[rank]}> · ${group.length}`,
      value: memberList(group),
      inline: false,
    });
  }

  return { embeds: [embed] };
}
