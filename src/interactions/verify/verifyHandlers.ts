/**
 * Verify: bottone del pannello e submit del modal.
 *
 * Il ruolo `✅ Verified` viene assegnato al SUBMIT VALIDO del modal, non alla
 * pressione del bottone. Il bottone apre soltanto il form.
 */
import type { ModalSubmitInteraction } from 'discord.js';
import { successEmbed, warningEmbed } from '../../components/embeds/base.js';
import { buildVerifyModal, VERIFY_FIELDS } from '../../components/embeds/verifyPanel.js';
import { handleInteractionError } from '../../errors/handleInteractionError.js';
import type { ComponentHandler, ModalHandler } from '../../types/command.js';
import { defer, respond } from '../../utils/respond.js';
import { validateVerificationForm } from '../../utils/validation.js';

/** Apre il modal. Nessun ruolo viene assegnato qui. */
export const verifyButtonHandler: ComponentHandler = {
  namespace: 'verify',

  async handle(interaction, parsed, _ctx): Promise<void> {
    if (parsed.action !== 'start' || !interaction.isButton()) return;

    try {
      // `showModal` e' gia' la risposta all'interaction: nessun defer prima.
      await interaction.showModal(buildVerifyModal());
    } catch (error) {
      await handleInteractionError(interaction, error, {
        operation: 'button:verify:start',
        actorDiscordId: interaction.user.id,
      });
    }
  },
};

export const verifyModalHandler: ModalHandler = {
  namespace: 'verify',

  async handle(interaction: ModalSubmitInteraction, parsed, ctx): Promise<void> {
    if (parsed.action !== 'submit') return;

    // La verifica tocca database e API Discord: prendiamo subito in carico
    // l'interaction per non superare i 3 secondi.
    await defer(interaction, { ephemeral: true });

    try {
      const form = validateVerificationForm({
        rpName: interaction.fields.getTextInputValue(VERIFY_FIELDS.rpName),
        rpSurname: interaction.fields.getTextInputValue(VERIFY_FIELDS.rpSurname),
        citizenId: interaction.fields.getTextInputValue(VERIFY_FIELDS.citizenId),
        phone: interaction.fields.getTextInputValue(VERIFY_FIELDS.phone),
        referral: interaction.fields.getTextInputValue(VERIFY_FIELDS.referral),
      });

      const outcome = await ctx.verification.verify({
        discordId: interaction.user.id,
        username: interaction.user.username,
        displayName:
          interaction.member && 'displayName' in interaction.member
            ? interaction.member.displayName
            : interaction.user.displayName,
        form,
      });

      if (outcome.kind === 'already-verified') {
        await respond(interaction, {
          embeds: [
            warningEmbed(
              'Sei già verificato',
              [
                'La tua verifica risulta già registrata: non serve rifarla.',
                '',
                'Se non vedi i canali della community, il ruolo è stato riallineato adesso.',
                'Se il problema persiste contatta un OG.',
              ].join('\n'),
            ),
          ],
        });
        return;
      }

      await respond(interaction, {
        embeds: [
          successEmbed(
            'VERIFICA COMPLETATA',
            [
              'La tua verifica è stata registrata correttamente.',
              '',
              '**Hai ottenuto**',
              '✅ `Verified`',
              '',
              'Ora puoi accedere alle aree community disponibili.',
              '',
              '> Vuoi entrare nella gang? Usa `/apply ttp`.',
              '> La candidatura verrà valutata dalla Leadership.',
            ].join('\n'),
          ),
        ],
      });
    } catch (error) {
      await handleInteractionError(interaction, error, {
        operation: 'modal:verify:submit',
        actorDiscordId: interaction.user.id,
      });
    }
  },
};
