/**
 * Control panel della Leadership.
 */
import { ActionRowBuilder, type BaseMessageOptions, ButtonBuilder, ButtonStyle } from 'discord.js';
import { RANK_LABEL, RANK_ORDER } from '../../config/constants.js';
import type { DashboardStats } from '../../services/statsService.js';
import { buildCustomId } from '../../utils/customId.js';
import { brandEmbed } from './base.js';

export const PANEL_BUTTONS = {
  members: buildCustomId('panel', 'members'),
  community: buildCustomId('panel', 'community'),
  roster: buildCustomId('panel', 'roster'),
  requests: buildCustomId('panel', 'requests'),
  search: buildCustomId('panel', 'search'),
  blacklist: buildCustomId('panel', 'blacklist'),
  refresh: buildCustomId('panel', 'refresh'),
} as const;

/** Allinea numeri e etichette in una colonna leggibile. */
function statLine(label: string, value: number, width = 20): string {
  const padded = label.padEnd(width, ' ');
  return `${padded}${String(value).padStart(4, ' ')}`;
}

export function buildStatsBlock(stats: DashboardStats): string {
  return [
    '```',
    statLine('TTP MEMBERS', stats.ttpMembers),
    statLine('COMMUNITY', stats.community),
    statLine('ACTIVE', stats.active),
    statLine('INACTIVE', stats.inactive),
    statLine('PENDING TTP REQ', stats.pendingApplications),
    statLine('BLACKLISTED', stats.blacklisted),
    '```',
  ].join('\n');
}

export function buildControlPanel(stats: DashboardStats): BaseMessageOptions {
  const embed = brandEmbed('MANAGEMENT SYSTEM')
    .setDescription(buildStatsBlock(stats))
    .addFields({
      name: 'Gerarchia',
      value:
        [...RANK_ORDER]
          .reverse()
          .map((rank) => `${RANK_LABEL[rank]} · **${stats.byRank[rank]}**`)
          .join('\n') || '—',
      inline: false,
    })
    .setFooter({ text: 'Solo la Leadership può usare questi comandi' });

  const rows: ActionRowBuilder<ButtonBuilder>[] = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(PANEL_BUTTONS.members)
        .setLabel('MEMBERS')
        .setEmoji('👥')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(PANEL_BUTTONS.community)
        .setLabel('COMMUNITY')
        .setEmoji('🏙')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(PANEL_BUTTONS.roster)
        .setLabel('ROSTER')
        .setEmoji('📋')
        .setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(PANEL_BUTTONS.requests)
        .setLabel(
          stats.pendingApplications > 0
            ? `TTP REQUESTS (${stats.pendingApplications})`
            : 'TTP REQUESTS',
        )
        .setEmoji('📨')
        .setStyle(stats.pendingApplications > 0 ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(PANEL_BUTTONS.search)
        .setLabel('SEARCH')
        .setEmoji('🔍')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(PANEL_BUTTONS.blacklist)
        .setLabel('BLACKLIST')
        .setEmoji('🚫')
        .setStyle(ButtonStyle.Danger),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(PANEL_BUTTONS.refresh)
        .setLabel('Aggiorna')
        .setEmoji('🔄')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];

  return { embeds: [embed], components: rows };
}
