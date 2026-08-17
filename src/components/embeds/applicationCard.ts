/**
 * Embed e bottoni delle candidature TTP, nel canale di review.
 */
import {
  ActionRowBuilder,
  type BaseMessageOptions,
  ButtonBuilder,
  ButtonStyle,
  type EmbedBuilder,
} from 'discord.js';
import { TtpApplicationStatus } from '../../generated/prisma/enums.js';
import { EMBED_COLOR } from '../../config/constants.js';
import type { TtpApplication, Verification } from '../../repositories/types.js';
import { buildCustomId } from '../../utils/customId.js';
import { brandEmbed, escapeMarkdown, formatDate, mention, truncate } from './base.js';

const STATUS_PRESENTATION: Record<TtpApplicationStatus, { label: string; color: number }> = {
  PENDING: { label: '⏳ In attesa di revisione', color: EMBED_COLOR.warning },
  APPROVED: { label: '✅ Approvata', color: EMBED_COLOR.success },
  REJECTED: { label: '❌ Rifiutata', color: EMBED_COLOR.danger },
  CANCELLED: { label: '🗑 Annullata', color: EMBED_COLOR.neutral },
};

export function buildApplicationEmbed(
  application: TtpApplication,
  verification: Verification | null,
): EmbedBuilder {
  const presentation = STATUS_PRESENTATION[application.status];

  const embed = brandEmbed('TTP MEMBERSHIP REQUEST')
    .setColor(presentation.color)
    .addFields(
      { name: 'Discord', value: mention(application.discordId), inline: true },
      { name: 'Stato', value: presentation.label, inline: true },
      { name: 'Requested', value: formatDate(application.requestedAt), inline: true },
    );

  if (verification) {
    embed.addFields(
      {
        name: 'Nome IC',
        value: escapeMarkdown(`${verification.rpName} ${verification.rpSurname}`),
        inline: true,
      },
      { name: 'Citizen ID', value: `\`${verification.citizenId}\``, inline: true },
      { name: 'Telefono', value: `\`${verification.phone}\``, inline: true },
      {
        name: 'Referral',
        value: truncate(escapeMarkdown(verification.referral)),
        inline: false,
      },
      { name: 'Verified', value: formatDate(verification.verifiedAt), inline: true },
    );
  } else {
    embed.addFields({
      name: '⚠️ Verifica',
      value: 'Nessuna verifica attiva trovata a database.',
      inline: false,
    });
  }

  if (application.notes) {
    embed.addFields({
      name: 'Note del candidato',
      value: truncate(escapeMarkdown(application.notes)),
      inline: false,
    });
  }

  if (application.status !== TtpApplicationStatus.PENDING) {
    embed.addFields({
      name: 'Revisione',
      value: [
        `Da: ${mention(application.reviewedByDiscordId)}`,
        `Il: ${formatDate(application.reviewedAt)}`,
        application.rejectionReason ? `Motivo: ${escapeMarkdown(application.rejectionReason)}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      inline: false,
    });
  }

  embed.setFooter({ text: `Application ${application.id}` });
  return embed;
}

/** Bottoni di review. Assenti se la candidatura è già stata gestita. */
export function buildApplicationActions(
  application: TtpApplication,
): ActionRowBuilder<ButtonBuilder>[] {
  if (application.status !== TtpApplicationStatus.PENDING) return [];

  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(buildCustomId('application', 'approve', application.id))
        .setLabel('APPROVE TTP')
        .setEmoji('✅')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(buildCustomId('application', 'reject', application.id))
        .setLabel('REJECT')
        .setEmoji('❌')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(buildCustomId('application', 'blacklist', application.id))
        .setLabel('BLACKLIST')
        .setEmoji('🚫')
        .setStyle(ButtonStyle.Danger),
    ),
  ];
}

export function buildApplicationMessage(
  application: TtpApplication,
  verification: Verification | null,
): BaseMessageOptions {
  return {
    embeds: [buildApplicationEmbed(application, verification)],
    components: buildApplicationActions(application),
  };
}
