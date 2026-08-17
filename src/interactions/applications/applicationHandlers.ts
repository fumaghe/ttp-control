/**
 * Bottoni di review delle candidature: APPROVE / REJECT / BLACKLIST.
 *
 * L'authorization viene RIVALUTATA a ogni click. Il messaggio è stato
 * pubblicato dal bot in un canale della Leadership, ma questo non dice nulla
 * su chi sta premendo il bottone adesso.
 */
import { ModalBuilder } from '@discordjs/builders';
import { TextInputStyle } from 'discord-api-types/v10';
import { MemberRank } from '../../generated/prisma/enums.js';
import { RANK_LABEL } from '../../config/constants.js';
import { AppError, ERROR_CODE } from '../../errors/AppError.js';
import { handleInteractionError } from '../../errors/handleInteractionError.js';
import { mention, successEmbed, warningEmbed } from '../../components/embeds/base.js';
import { buildApplicationMessage } from '../../components/embeds/applicationCard.js';
import { textField } from '../../components/modals/fields.js';
import type { ComponentHandler, ModalHandler } from '../../types/command.js';
import type { AppContext } from '../../types/context.js';
import { buildCustomId, requireArg } from '../../utils/customId.js';
import { defer, respond } from '../../utils/respond.js';
import { validateReason } from '../../utils/validation.js';

/** Aggiorna il messaggio originale della candidatura, se ancora presente. */
async function refreshApplicationMessage(ctx: AppContext, applicationId: string): Promise<void> {
  const application = await ctx.applications.findById(applicationId);
  if (!application?.channelId || !application.messageId) return;

  const verification = await ctx.repos.verifications.findByDiscordId(application.discordId);

  // Il messaggio potrebbe essere stato cancellato a mano: un refresh mancato
  // non deve invalidare l'approvazione o il rifiuto appena registrati.
  await ctx.gateway
    .editMessage(
      application.channelId,
      application.messageId,
      buildApplicationMessage(application, verification),
    )
    .catch(() => false);
}

export const applicationButtonHandler: ComponentHandler = {
  namespace: 'application',

  async handle(interaction, parsed, ctx): Promise<void> {
    if (!interaction.isButton()) return;

    const applicationId = requireArg(parsed, 0, 'l’ID della candidatura');
    const actorId = interaction.user.id;

    // REJECT apre un modal: `showModal` è già la risposta all'interaction,
    // quindi non va preceduto da un defer.
    if (parsed.action === 'reject') {
      try {
        const actor = await ctx.authorization.resolveActor(actorId);
        await ctx.authorization.require(actor, 'application.review');

        const modal = new ModalBuilder()
          .setCustomId(buildCustomId('application', 'rejectSubmit', applicationId))
          .setTitle('Rifiuta candidatura')
          .addLabelComponents(
            textField({
              customId: 'reason',
              label: 'Motivazione del rifiuto',
              description: 'Verrà comunicata al candidato via DM',
              style: TextInputStyle.Paragraph,
              minLength: 3,
              maxLength: 500,
            }),
          );

        await interaction.responder.showModal(modal);
      } catch (error) {
        await handleInteractionError(interaction, error, {
          operation: 'button:application:reject',
          actorDiscordId: actorId,
        });
      }
      return;
    }

    await defer(interaction, { ephemeral: true });

    try {
      const actor = await ctx.authorization.resolveActor(actorId);

      switch (parsed.action) {
        case 'approve': {
          await ctx.authorization.require(actor, 'application.review');

          const application = await ctx.applications.findById(applicationId);
          if (!application) {
            throw new AppError(ERROR_CODE.APPLICATION_NOT_FOUND, 'Candidatura non trovata.');
          }

          // Anche il bersaglio va autorizzato: la review è un'operazione
          // amministrativa su una persona, non un click astratto.
          const target = await ctx.authorization.resolveTarget(application.discordId);
          if (!target) {
            throw new AppError(
              ERROR_CODE.TARGET_LEFT_GUILD,
              'Il candidato non è più presente nel server Discord.',
            );
          }
          await ctx.authorization.requireOn(actor, target, 'application.review');

          const rank = MemberRank.RESIDENT;
          await ctx.authorization.requireRankAssignment(actor, rank);

          const outcome = await ctx.applications.approve({
            applicationId,
            actorDiscordId: actorId,
            initialRank: rank,
          });

          await refreshApplicationMessage(ctx, applicationId);

          const embed = successEmbed(
            'Candidatura approvata',
            [
              `${mention(application.discordId)} è ora un membro della gang.`,
              '',
              '✅ `Verified`',
              '🩸 `TTP`',
              RANK_LABEL[outcome.rank],
              '',
              outcome.notified
                ? '📬 Il candidato è stato avvisato in DM.'
                : '⚠️ Non è stato possibile inviargli un DM.',
            ].join('\n'),
          );

          if (outcome.warnings.length > 0) {
            embed.addFields({ name: '⚠️ Da controllare', value: outcome.warnings.join('\n') });
          }

          await respond(interaction, { embeds: [embed] });
          return;
        }

        case 'blacklist': {
          await ctx.authorization.require(actor, 'blacklist.manage');

          const application = await ctx.applications.findById(applicationId);
          if (!application) {
            throw new AppError(ERROR_CODE.APPLICATION_NOT_FOUND, 'Candidatura non trovata.');
          }

          // La blacklist è un'azione separata dal rifiuto: prima si chiude la
          // candidatura, poi si blacklista.
          await ctx.applications
            .reject({
              applicationId,
              actorDiscordId: actorId,
              reason: 'Candidatura rifiutata e utente inserito in blacklist',
            })
            .catch(() => undefined);

          const outcome = await ctx.blacklist.add({
            discordId: application.discordId,
            reason: 'Blacklist decisa in fase di review della candidatura TTP',
            actorDiscordId: actorId,
          });

          await refreshApplicationMessage(ctx, applicationId);

          await respond(interaction, {
            embeds: [
              outcome.alreadyBlacklisted
                ? warningEmbed(
                    'Già in blacklist',
                    `${mention(application.discordId)} era già in blacklist.`,
                  )
                : successEmbed(
                    'Candidato inserito in blacklist',
                    `${mention(application.discordId)} non potrà più verificarsi né candidarsi.\n\nUsa \`/blacklist info\` per lo storico completo.`,
                  ),
            ],
          });
          return;
        }

        default:
          await respond(interaction, { content: 'Azione non riconosciuta.' });
      }
    } catch (error) {
      await handleInteractionError(interaction, error, {
        operation: `button:application:${parsed.action}`,
        actorDiscordId: actorId,
      });
    }
  },
};

export const applicationModalHandler: ModalHandler = {
  namespace: 'application',

  async handle(interaction, parsed, ctx): Promise<void> {
    if (parsed.action !== 'rejectSubmit') return;

    await defer(interaction, { ephemeral: true });
    const applicationId = requireArg(parsed, 0, 'l’ID della candidatura');
    const actorId = interaction.user.id;

    try {
      const actor = await ctx.authorization.resolveActor(actorId);
      await ctx.authorization.require(actor, 'application.review');

      const reason = validateReason(interaction.fields.getTextInputValue('reason'));
      const application = await ctx.applications.reject({
        applicationId,
        actorDiscordId: actorId,
        reason,
      });

      await refreshApplicationMessage(ctx, applicationId);

      await respond(interaction, {
        embeds: [
          successEmbed(
            'Candidatura rifiutata',
            [
              `${mention(application.discordId)} è stato informato via DM.`,
              '',
              '✅ Mantiene il ruolo `Verified`.',
              'Non è stato bannato né inserito in blacklist.',
            ].join('\n'),
          ),
        ],
      });
    } catch (error) {
      await handleInteractionError(interaction, error, {
        operation: 'modal:application:reject',
        actorDiscordId: actorId,
      });
    }
  },
};
