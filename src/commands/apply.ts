/**
 * `/apply ttp` — candidatura d'ingresso nella gang.
 *
 * È il ponte fra `Verified` e `TTP`: l'utente si candida, la Leadership
 * decide. La verifica da sola non basta e non è mai sufficiente.
 */
import { SlashCommandBuilder } from 'discord.js';
import { infoEmbed, successEmbed } from '../components/embeds/base.js';
import { handleInteractionError } from '../errors/handleInteractionError.js';
import type { SlashCommand } from '../types/command.js';
import { defer, respond } from '../utils/respond.js';
import { validateOptionalNotes } from '../utils/validation.js';

export const applyCommand: SlashCommand = {
  name: 'apply',

  data: new SlashCommandBuilder()
    .setName('apply')
    .setDescription('Candidature')
    .addSubcommand((sub) =>
      sub
        .setName('ttp')
        .setDescription('Candidati per entrare nella gang TTP')
        .addStringOption((o) =>
          o
            .setName('messaggio')
            .setDescription('Due righe su di te per la Leadership (facoltativo)'),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName('cancel').setDescription('Annulla la tua candidatura in attesa'),
    )
    .addSubcommand((sub) =>
      sub.setName('status').setDescription('Mostra lo stato della tua candidatura'),
    )
    .toJSON(),

  async execute(interaction, ctx): Promise<void> {
    await defer(interaction, { ephemeral: true });
    const subcommand = interaction.options.getSubcommand(true);

    try {
      switch (subcommand) {
        case 'ttp': {
          const notes = validateOptionalNotes(interaction.options.getString('messaggio'));

          await ctx.applications.create({
            discordId: interaction.user.id,
            username: interaction.user.username,
            displayName: interaction.user.displayName,
            notes: notes ?? undefined,
          });

          await respond(interaction, {
            embeds: [
              successEmbed(
                'Candidatura inviata',
                [
                  'La tua richiesta di ingresso è stata inoltrata alla Leadership.',
                  '',
                  'Riceverai un messaggio privato quando verrà valutata.',
                  '',
                  '> Nel frattempo mantieni l’accesso alle aree community.',
                ].join('\n'),
              ),
            ],
          });
          return;
        }

        case 'cancel': {
          await ctx.applications.cancel({
            discordId: interaction.user.id,
            actorDiscordId: interaction.user.id,
            reason: 'Annullata dal candidato',
          });

          await respond(interaction, {
            embeds: [
              successEmbed(
                'Candidatura annullata',
                'Potrai ricandidarti quando vorrai con `/apply ttp`.',
              ),
            ],
          });
          return;
        }

        case 'status': {
          const applications = await ctx.applications.historyFor(interaction.user.id);

          if (applications.length === 0) {
            await respond(interaction, {
              embeds: [
                infoEmbed(
                  'Nessuna candidatura',
                  'Non hai ancora inviato nessuna candidatura. Usa `/apply ttp` per farlo.',
                ),
              ],
            });
            return;
          }

          const embed = infoEmbed('Le tue candidature');
          for (const application of applications.slice(0, 10)) {
            embed.addFields({
              name: `${application.status} · ${application.requestedAt.toLocaleDateString('it-IT')}`,
              value: application.rejectionReason
                ? `Motivazione: ${application.rejectionReason}`
                : '—',
            });
          }

          await respond(interaction, { embeds: [embed] });
          return;
        }

        default:
          await respond(interaction, { content: 'Sottocomando non riconosciuto.' });
      }
    } catch (error) {
      await handleInteractionError(interaction, error, {
        operation: `/apply ${subcommand}`,
        actorDiscordId: interaction.user.id,
      });
    }
  },
};
