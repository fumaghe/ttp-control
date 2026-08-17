/**
 * `/blacklist` — la blacklist vive nel database ed è identificata dal
 * Discord ID, mai dallo username.
 *
 * Nessun ban automatico: le azioni distruttive dipendono dalla policy della
 * guild (`GuildConfig.blacklistAutoKick` / `blacklistAutoBan`), disattivate
 * di default.
 */
import { SlashCommandBuilder } from '@discordjs/builders';
import { PermissionFlagsBits } from 'discord-api-types/v10';
import {
  escapeMarkdown,
  formatDate,
  infoEmbed,
  mention,
  successEmbed,
  truncate,
  warningEmbed,
} from '../components/embeds/base.js';
import { handleInteractionError } from '../errors/handleInteractionError.js';
import type { SlashCommand } from '../types/command.js';
import { defer, respond } from '../utils/respond.js';
import {
  validateOptionalNotes,
  validateOptionalReason,
  validateReason,
  validateText,
} from '../utils/validation.js';

export const blacklistCommand: SlashCommand = {
  name: 'blacklist',

  data: new SlashCommandBuilder()
    .setName('blacklist')
    .setDescription('Gestione della blacklist')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Aggiunge un utente alla blacklist')
        .addUserOption((o) => o.setName('user').setDescription('L’utente').setRequired(true))
        .addStringOption((o) => o.setName('reason').setDescription('Motivazione').setRequired(true))
        .addStringOption((o) =>
          o.setName('character').setDescription('Nome del personaggio (facoltativo)'),
        )
        .addStringOption((o) => o.setName('notes').setDescription('Note interne')),
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Rimuove un utente dalla blacklist')
        .addUserOption((o) => o.setName('user').setDescription('L’utente').setRequired(true))
        .addStringOption((o) => o.setName('reason').setDescription('Motivazione')),
    )
    .addSubcommand((sub) =>
      sub
        .setName('info')
        .setDescription('Storico blacklist di un utente')
        .addUserOption((o) => o.setName('user').setDescription('L’utente').setRequired(true)),
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('Elenca tutte le blacklist attive'))
    .toJSON(),

  async execute(interaction, ctx): Promise<void> {
    await defer(interaction, { ephemeral: true });

    const subcommand = interaction.options.getSubcommand(true);
    const actorId = interaction.user.id;

    try {
      const actor = await ctx.authorization.resolveActor(actorId);

      if (subcommand === 'list') {
        await ctx.authorization.require(actor, 'blacklist.manage');
        const entries = await ctx.blacklist.listActive({ take: 50 });

        if (entries.length === 0) {
          await respond(interaction, {
            embeds: [infoEmbed('Blacklist', 'Nessun utente è attualmente in blacklist.')],
          });
          return;
        }

        const lines = entries.map(
          (entry) =>
            `• <@${entry.discordId}> — ${escapeMarkdown(entry.reason)} _(${formatDate(entry.createdAt)})_`,
        );

        await respond(interaction, {
          embeds: [
            infoEmbed(`Blacklist attive · ${entries.length}`, truncate(lines.join('\n'), 4000)),
          ],
        });
        return;
      }

      const targetUser = interaction.options.getUser('user', true);

      if (subcommand === 'info') {
        await ctx.authorization.require(actor, 'blacklist.manage');

        const [active, history] = await Promise.all([
          ctx.blacklist.findActive(targetUser.id),
          ctx.blacklist.history(targetUser.id),
        ]);

        const embed = infoEmbed(`Blacklist · ${escapeMarkdown(targetUser.displayName)}`)
          .setDescription(mention(targetUser.id))
          .addFields({
            name: 'Stato attuale',
            value: active ? '🚫 **IN BLACKLIST**' : '✅ Non in blacklist',
            inline: false,
          });

        if (active) {
          embed.addFields(
            { name: 'Motivazione', value: truncate(escapeMarkdown(active.reason)) },
            { name: 'Inserito da', value: mention(active.createdByDiscordId), inline: true },
            { name: 'Data', value: formatDate(active.createdAt), inline: true },
          );
          if (active.notes) {
            embed.addFields({ name: 'Note', value: truncate(escapeMarkdown(active.notes)) });
          }
        }

        const past = history.filter((entry) => !entry.active);
        if (past.length > 0) {
          embed.addFields({
            name: `Storico · ${past.length}`,
            value: truncate(
              past
                .slice(0, 5)
                .map(
                  (entry) =>
                    `• ${formatDate(entry.createdAt)} → ${formatDate(entry.removedAt)} — ${escapeMarkdown(entry.reason)}`,
                )
                .join('\n'),
            ),
          });
        }

        await respond(interaction, { embeds: [embed] });
        return;
      }

      // --- add / remove: mutano lo stato -----------------------------------
      const target = await ctx.authorization.resolveTarget(targetUser.id);

      // Un utente può essere blacklistato anche se non è nel server: in quel
      // caso non c'è un target Discord su cui applicare la gerarchia, e la
      // sola matrice applicativa è sufficiente.
      if (target) {
        await ctx.authorization.requireOn(actor, target, 'blacklist.manage');
      } else {
        await ctx.authorization.require(actor, 'blacklist.manage');
      }

      if (subcommand === 'add') {
        const reason = validateReason(interaction.options.getString('reason', true));
        const characterRaw = interaction.options.getString('character');
        const notes = validateOptionalNotes(interaction.options.getString('notes'));

        const character = characterRaw
          ? validateText(characterRaw, { label: 'Personaggio', min: 2, max: 64 })
          : null;
        const [rpName, ...rest] = character?.split(' ') ?? [];

        const outcome = await ctx.blacklist.add({
          discordId: targetUser.id,
          reason,
          actorDiscordId: actorId,
          rpName: rpName ?? null,
          rpSurname: rest.length > 0 ? rest.join(' ') : null,
          notes,
        });

        if (outcome.alreadyBlacklisted) {
          await respond(interaction, {
            embeds: [
              warningEmbed(
                'Già in blacklist',
                `${mention(targetUser.id)} è già in blacklist dal ${formatDate(outcome.entry.createdAt)}.`,
              ),
            ],
          });
          return;
        }

        const embed = successEmbed(
          'Utente aggiunto alla blacklist',
          `${mention(targetUser.id)}\n\n**Motivazione:** ${escapeMarkdown(reason)}`,
        );

        const consequences = [
          outcome.verifiedRevoked ? '✅ `Verified` revocato' : '',
          outcome.wasTtpMember ? '⚠️ Era un membro TTP: valuta `/member remove`' : '',
          outcome.kicked ? '👢 Espulso dal server (policy attiva)' : '',
          outcome.banned ? '⛔ Bannato dal server (policy attiva)' : '',
        ].filter(Boolean);

        if (consequences.length > 0) {
          embed.addFields({ name: 'Conseguenze', value: consequences.join('\n') });
        }
        if (!outcome.kicked && !outcome.banned) {
          embed.setFooter({
            text: 'Nessuna espulsione automatica: la policy della gang non la prevede.',
          });
        }

        await respond(interaction, { embeds: [embed] });
        return;
      }

      if (subcommand === 'remove') {
        const reason = validateOptionalReason(interaction.options.getString('reason'));
        await ctx.blacklist.remove({
          discordId: targetUser.id,
          actorDiscordId: actorId,
          reason: reason ?? undefined,
        });

        await respond(interaction, {
          embeds: [
            successEmbed(
              'Rimosso dalla blacklist',
              `${mention(targetUser.id)} può nuovamente verificarsi e candidarsi.\n\n> Il ruolo \`Verified\` **non** viene riassegnato automaticamente.`,
            ),
          ],
        });
        return;
      }

      await respond(interaction, { content: 'Sottocomando non riconosciuto.' });
    } catch (error) {
      await handleInteractionError(interaction, error, {
        operation: `/blacklist ${subcommand}`,
        actorDiscordId: actorId,
      });
    }
  },
};
