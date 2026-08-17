/**
 * Pannello pubblico di verifica e relativo modal.
 */
import {
  ActionRowBuilder,
  type BaseMessageOptions,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputStyle,
} from 'discord.js';
import { EMBED_COLOR, GANG_NAME } from '../../config/constants.js';
import { buildCustomId } from '../../utils/customId.js';
import { textField } from '../modals/fields.js';
import { brandEmbed } from './base.js';

export const VERIFY_BUTTON_ID = buildCustomId('verify', 'start');
export const VERIFY_MODAL_ID = buildCustomId('verify', 'submit');

/** ID dei campi del modal: usati anche in lettura al submit. */
export const VERIFY_FIELDS = {
  rpName: 'rpName',
  rpSurname: 'rpSurname',
  citizenId: 'citizenId',
  phone: 'phone',
  referral: 'referral',
} as const;

export function buildVerifyPanel(): BaseMessageOptions {
  const embed = brandEmbed('ACCESS SYSTEM')
    .setDescription(
      [
        `Benvenuto nel Discord di **${GANG_NAME}**.`,
        '',
        'Per accedere alle aree della community devi completare la verifica.',
        'Ti verranno chiesti i dati del tuo personaggio **in character**.',
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
      .setEmoji('🔐')
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
        placeholder: 'Il nome del tuo personaggio',
        style: TextInputStyle.Short,
        minLength: 2,
        maxLength: 32,
      }),
      textField({
        customId: VERIFY_FIELDS.rpSurname,
        label: 'Cognome IC',
        placeholder: 'Il cognome del tuo personaggio',
        style: TextInputStyle.Short,
        minLength: 2,
        maxLength: 32,
      }),
      textField({
        customId: VERIFY_FIELDS.citizenId,
        label: 'ID cittadino',
        placeholder: 'Es. 8712',
        style: TextInputStyle.Short,
        minLength: 1,
        maxLength: 16,
      }),
      textField({
        customId: VERIFY_FIELDS.phone,
        label: 'Telefono IC',
        placeholder: 'Es. 555-1234',
        style: TextInputStyle.Short,
        minLength: 3,
        maxLength: 20,
      }),
      textField({
        customId: VERIFY_FIELDS.referral,
        label: 'Come conosci i TTP?',
        placeholder: 'Chi ti ha invitato, dove ci hai incontrati…',
        style: TextInputStyle.Paragraph,
        minLength: 3,
        maxLength: 300,
      }),
    );
}
