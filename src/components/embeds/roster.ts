/**
 * Roster con paginazione.
 *
 * Gli embed Discord hanno limiti stretti (4096 caratteri di descrizione,
 * 6000 totali): con una gang numerosa il roster va spezzato in pagine, non
 * troncato in silenzio.
 */
import { ActionRowBuilder, ButtonBuilder, type EmbedBuilder } from '@discordjs/builders';
import { ButtonStyle } from 'discord-api-types/v10';
import { MemberStatus } from '../../generated/prisma/enums.js';
import { DISCORD_LIMITS, RANK_LABEL, RANK_ORDER } from '../../config/constants.js';
import type { Member } from '../../repositories/types.js';
import { buildCustomId } from '../../utils/customId.js';
import { brandEmbed, escapeMarkdown } from './base.js';

/** Righe per pagina: sta comodamente sotto i limiti dell'embed. */
const LINES_PER_PAGE = 40;

export interface RosterPage {
  readonly embed: EmbedBuilder;
  readonly page: number;
  readonly totalPages: number;
}

function memberLine(member: Member): string {
  const name =
    [member.rpName, member.rpSurname].filter(Boolean).join(' ') || `<@${member.discordId}>`;
  const flag = member.status === MemberStatus.INACTIVE ? ' 💤' : '';
  return `• ${escapeMarkdown(name)} — <@${member.discordId}>${flag}`;
}

/** Costruisce le righe raggruppate per rank, dall'alto verso il basso. */
function buildLines(members: readonly Member[]): string[] {
  const lines: string[] = [];

  for (const rank of [...RANK_ORDER].reverse()) {
    const group = members.filter((m) => m.rank === rank);
    if (group.length === 0) continue;

    lines.push(`**${RANK_LABEL[rank].toUpperCase()} · ${group.length}**`);
    for (const member of group) lines.push(memberLine(member));
    lines.push('');
  }

  return lines;
}

export interface RosterFilterSummary {
  readonly rank?: string | undefined;
  readonly status?: string | undefined;
  readonly roleMention?: string | undefined;
}

export function buildRosterPages(
  members: readonly Member[],
  filters: RosterFilterSummary,
): RosterPage[] {
  const lines = buildLines(members);
  const total = members.length;
  const active = members.filter((m) => m.status === MemberStatus.ACTIVE).length;
  const inactive = members.filter((m) => m.status === MemberStatus.INACTIVE).length;

  const chunks: string[][] = [];
  for (let index = 0; index < lines.length; index += LINES_PER_PAGE) {
    chunks.push(lines.slice(index, index + LINES_PER_PAGE));
  }
  if (chunks.length === 0) chunks.push(['_Nessun membro corrisponde ai filtri._']);

  const activeFilters = [
    filters.rank ? `rank: **${filters.rank}**` : '',
    filters.status ? `status: **${filters.status}**` : '',
    filters.roleMention ? `ruolo: ${filters.roleMention}` : '',
  ].filter(Boolean);

  return chunks.map((chunk, index) => {
    const embed = brandEmbed('ROSTER')
      .setDescription(chunk.join('\n').slice(0, DISCORD_LIMITS.embedDescription))
      .addFields(
        { name: 'TOTAL', value: String(total), inline: true },
        { name: 'ACTIVE', value: String(active), inline: true },
        { name: 'INACTIVE', value: String(inactive), inline: true },
      );

    if (activeFilters.length > 0) {
      embed.addFields({ name: 'Filtri', value: activeFilters.join(' · '), inline: false });
    }

    embed.setFooter({ text: `Pagina ${index + 1} / ${chunks.length}` });

    return { embed, page: index, totalPages: chunks.length };
  });
}

/**
 * Bottoni di paginazione.
 *
 * Il `customId` incorpora la pagina richiesta e i filtri, così il roster si
 * ricalcola al click senza dover mantenere stato in memoria: sopravvive a un
 * restart del bot.
 */
export function buildRosterControls(
  page: number,
  totalPages: number,
  filterToken: string,
): ActionRowBuilder<ButtonBuilder>[] {
  if (totalPages <= 1) return [];

  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(buildCustomId('roster', 'page', String(Math.max(page - 1, 0)), filterToken))
        .setLabel('Precedente')
        .setEmoji({ name: '◀️' })
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === 0),
      new ButtonBuilder()
        .setCustomId(buildCustomId('roster', 'noop'))
        .setLabel(`${page + 1} / ${totalPages}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(
          buildCustomId('roster', 'page', String(Math.min(page + 1, totalPages - 1)), filterToken),
        )
        .setLabel('Successiva')
        .setEmoji({ name: '▶️' })
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= totalPages - 1),
    ),
  ];
}

/**
 * Codifica i filtri in un token per il `customId`.
 * Formato: `<rank|_>-<status|_>` — solo caratteri ammessi dal validatore.
 */
export function encodeFilterToken(rank: string | null, status: string | null): string {
  return `${rank ?? '_'}-${status ?? '_'}`;
}

export function decodeFilterToken(token: string): {
  rank: string | null;
  status: string | null;
} {
  const [rank, status] = token.split('-');
  return {
    rank: rank === undefined || rank === '_' ? null : rank,
    status: status === undefined || status === '_' ? null : status,
  };
}
