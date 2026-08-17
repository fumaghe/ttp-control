/**
 * Pannello pubblico di verifica e relativo modal.
 */
import { ActionRowBuilder, ButtonBuilder, ModalBuilder } from '@discordjs/builders';
import { ButtonStyle, TextInputStyle } from 'discord-api-types/v10';
import type { MessagePayload } from '../../discord/payload.js';
import { EMBED_COLOR, GANG_NAME } from '../../config/constants.js';
import { buildCustomId } from '../../utils/customId.js';
import { textField } from '../modals/fields.js';
import { brandEmbed } from './base.js';

export const VERIFY_BUTTON_ID = buildCustomId('verify', 'start');
export const VERIFY_MODAL_ID = buildCustomId('verify', 'submit');

/** ID dei campi del modal: usati anche in lettura al submit. */
export const VERIFY_FIELDS = {
  rpName: 'rpName',
  oocName: 'oocName',
} as const;

export function buildVerifyPanel(): MessagePayload {
  const embed = brandEmbed('ACCESS SYSTEM')
    .setDescription(
      [
        `Benvenuto nel Discord di **${GANG_NAME}**.`,
        '',
        'Per accedere alle aree della community devi completare la verifica.',
        'Ti verranno chiesti solamente il tuo **Nome IC** e il tuo **Nome OOC**.',
        '',
        '**Cosa ottieni**',
        '✅ il ruolo `Verified`',
        '💬 accesso alle aree **STREET** e **CHILL ZONE**',
        '',
        '> La verifica **non** ti rende un membro della gang.',
        '> Per entrare nei TTP serve una candidatura approvata dalla Leadership.',
      ].join('\n'),
    )
    .setColor(EMBED_COLOR.brand);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(VERIFY_BUTTON_ID)
      .setLabel('VERIFY')
      .setEmoji({ name: '🔐' })
      .setStyle(ButtonStyle.Success),
  );

  return { embeds: [embed], components: [row] };
}

export function buildVerifyModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(VERIFY_MODAL_ID)
    .setTitle('Verifica — TTP Impero')
    .addLabelComponents(
      textField({
        customId: VERIFY_FIELDS.rpName,
        label: 'Nome IC',
        placeholder: 'Nome completo del tuo personaggio',
        style: TextInputStyle.Short,
        minLength: 2,
        maxLength: 64,
      }),
      textField({
        customId: VERIFY_FIELDS.oocName,
        label: 'Nome OOC',
        placeholder: 'Il tuo nome OOC',
        style: TextInputStyle.Short,
        minLength: 2,
        maxLength: 64,
      }),
    );
}