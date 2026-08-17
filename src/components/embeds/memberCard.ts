/**
 * Member card e bottoni di azione rapida.
 *
 * I bottoni vengono mostrati solo a chi è autorizzato, ma l'authorization
 * viene comunque RIFATTA al click: un pannello mostrato una volta non è un
 * lasciapassare permanente.
 */
import { ActionRowBuilder, ButtonBuilder, type EmbedBuilder } from '@discordjs/builders';
import { ButtonStyle } from 'discord-api-types/v10';
import { MemberStatus, type SpecialRole } from '../../generated/prisma/enums.js';
import { EMBED_COLOR, RANK_LABEL } from '../../config/constants.js';
import type { Member } from '../../repositories/types.js';
import { buildCustomId } from '../../utils/customId.js';
import { brandEmbed, escapeMarkdown, formatDate, mention, truncate } from './base.js';

export const SPECIAL_ROLE_LABEL: Readonly<Record<SpecialRole, string>> = {
  SHOOTER: '🎯 Shooter',
  MAIN_SHOOTER: '👑 Main Shooter',
  HONOR_1: '🎖 Honor 1',
  HONOR_2: '🏅 Honor 2',
  SUPPORTER: '💗 Supporter',
  FIRST_DAY: '🥇 First Day',
};

export const STATUS_LABEL: Readonly<Record<MemberStatus, string>> = {
  ACTIVE: '🟢 Active',
  INACTIVE: '💤 Inactive',
  PERMADEATH: '💀 Permadeath',
  LEFT: '🚪 Ha lasciato la gang',
};

const STATUS_COLOR: Readonly<Record<MemberStatus, number>> = {
  ACTIVE: EMBED_COLOR.success,
  INACTIVE: EMBED_COLOR.warning,
  PERMADEATH: EMBED_COLOR.neutral,
  LEFT: EMBED_COLOR.neutral,
};

export interface MemberCardData {
  readonly member: Member;
  readonly displayName: string;
  readonly specialRoles: readonly SpecialRole[];
  /** Le note della Leadership si mostrano solo a chi è autorizzato. */
  readonly includeNotes: boolean;
}

export function buildMemberCard(data: MemberCardData): EmbedBuilder {
  const { member } = data;
  const fullName = [member.rpName, member.rpSurname].filter(Boolean).join(' ') || data.displayName;

  const embed = brandEmbed('TTP MEMBER')
    .setColor(STATUS_COLOR[member.status])
    .setDescription(`### ${escapeMarkdown(fullName)}\n${mention(member.discordId)}`)
    .addFields(
      { name: 'RANK', value: RANK_LABEL[member.rank], inline: true },
      { name: 'STATUS', value: STATUS_LABEL[member.status], inline: true },
      {
        name: 'TTP SINCE',
        value: formatDate(member.joinedTtpAt),
        inline: true,
      },
    );

  if (data.specialRoles.length > 0) {
    embed.addFields({
      name: 'ROLES',
      value: data.specialRoles.map((role) => SPECIAL_ROLE_LABEL[role]).join('\n'),
      inline: true,
    });
  }

  if (member.citizenId && member.citizenId !== '—') {
    embed.addFields({ name: 'CITIZEN ID', value: `\`${member.citizenId}\``, inline: true });
  }

  if (member.recruitedByDiscordId) {
    embed.addFields({
      name: 'RECRUITED BY',
      value: mention(member.recruitedByDiscordId),
      inline: true,
    });
  }

  if (member.leftTtpAt) {
    embed.addFields({
      name: member.status === MemberStatus.PERMADEATH ? 'PERMADEATH' : 'LEFT',
      value: formatDate(member.leftTtpAt),
      inline: true,
    });
  }

  // Le note sono materiale interno della Leadership: mai in chiaro a chi non
  // ha il permesso `member.notes.view`.
  if (data.includeNotes && member.notes) {
    embed.addFields({
      name: '📝 NOTE LEADERSHIP',
      value: truncate(escapeMarkdown(member.notes)),
      inline: false,
    });
  }

  embed.setFooter({ text: `ID: ${member.discordId}` });
  return embed;
}

export interface MemberActionFlags {
  readonly canPromote: boolean;
  readonly canDemote: boolean;
  readonly canManageRoles: boolean;
  readonly canChangeStatus: boolean;
  readonly canEditNotes: boolean;
  readonly canRemove: boolean;
}

/** Righe di bottoni per la member card, filtrate sui permessi dell'attore. */
export function buildMemberActions(
  discordId: string,
  flags: MemberActionFlags,
  status: MemberStatus,
): ActionRowBuilder<ButtonBuilder>[] {
  const primary: ButtonBuilder[] = [];
  const secondary: ButtonBuilder[] = [];

  if (flags.canPromote) {
    primary.push(
      new ButtonBuilder()
        .setCustomId(buildCustomId('member', 'promote', discordId))
        .setLabel('PROMOTE')
        .setEmoji({ name: '⬆️' })
        .setStyle(ButtonStyle.Success),
    );
  }
  if (flags.canDemote) {
    primary.push(
      new ButtonBuilder()
        .setCustomId(buildCustomId('member', 'demote', discordId))
        .setLabel('DEMOTE')
        .setEmoji({ name: '⬇️' })
        .setStyle(ButtonStyle.Secondary),
    );
  }
  if (flags.canManageRoles) {
    primary.push(
      new ButtonBuilder()
        .setCustomId(buildCustomId('member', 'roles', discordId))
        .setLabel('ROLES')
        .setEmoji({ name: '🎭' })
        .setStyle(ButtonStyle.Secondary),
    );
  }

  if (flags.canChangeStatus) {
    secondary.push(
      new ButtonBuilder()
        .setCustomId(
          buildCustomId(
            'member',
            status === MemberStatus.INACTIVE ? 'active' : 'inactive',
            discordId,
          ),
        )
        .setLabel(status === MemberStatus.INACTIVE ? 'RIATTIVA' : 'INACTIVE')
        .setEmoji({ name: status === MemberStatus.INACTIVE ? '🟢' : '💤' })
        .setStyle(ButtonStyle.Secondary),
    );
  }
  if (flags.canEditNotes) {
    secondary.push(
      new ButtonBuilder()
        .setCustomId(buildCustomId('member', 'notes', discordId))
        .setLabel('NOTES')
        .setEmoji({ name: '📝' })
        .setStyle(ButtonStyle.Secondary),
    );
  }
  if (flags.canRemove) {
    secondary.push(
      new ButtonBuilder()
        .setCustomId(buildCustomId('member', 'remove', discordId))
        .setLabel('REMOVE')
        .setEmoji({ name: '🚪' })
        .setStyle(ButtonStyle.Danger),
    );
  }

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  if (primary.length > 0) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...primary));
  }
  if (secondary.length > 0) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...secondary));
  }
  return rows;
}
