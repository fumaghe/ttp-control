/**
 * `/community` — gestione di chi frequenta STREET/CHILL senza essere TTP.
 *
 * `makettp` non reimplementa nulla: chiama lo stesso `memberService.addToGang`
 * usato da `/member add` e dall'approvazione delle candidature.
 */
import { SlashCommandBuilder } from '@discordjs/builders';
import { PermissionFlagsBits } from 'discord-api-types/v10';
import { MemberRank } from '../generated/prisma/enums.js';
import { RANK_LABEL, RANK_ORDER } from '../config/constants.js';
import {
  escapeMarkdown,
  formatDate,
  infoEmbed,
  mention,
  successEmbed,
  truncate,
  warningEmbed,
} from '../components/embeds/base.js';
import { STATUS_LABEL } from '../components/embeds/memberCard.js';
import { handleInteractionError } from '../errors/handleInteractionError.js';
import type { SlashCommand } from '../types/command.js';
import { defer, respond } from '../utils/respond.js';
import { validateOptionalReason, validateReason } from '../utils/validation.js';

export const communityCommand: SlashCommand = {
  name: 'community',

  data: new SlashCommandBuilder()
    .setName('community')
    .setDescription('Gestione della community esterna alla gang')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addSubcommand((sub) =>
      sub
        .setName('list')
        .setDescription('Elenca verificati, friend e mafia')
        .addStringOption((o) =>
          o
            .setName('tipo')
            .setDescription('Cosa elencare')
            .addChoices(
              { name: 'Solo verificati', value: 'verified' },
              { name: 'Friend', value: 'friend' },
              { name: 'Mafia', value: 'mafia' },
              { name: 'Tutti', value: 'all' },
            ),
        )
        .addBooleanOption((o) =>
          o.setName('escludi-ttp').setDescription('Mostra solo chi NON è membro TTP (default: sì)'),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('info')
        .setDescription('Dossier completo su un utente')
        .addUserOption((o) => o.setName('user').setDescription('L’utente').setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('verified')
        .setDescription('Assegna o revoca manualmente il ruolo Verified')
        .addUserOption((o) => o.setName('user').setDescription('L’utente').setRequired(true))
        .addStringOption((o) =>
          o
            .setName('action')
            .setDescription('Assegna o revoca')
            .setRequired(true)
            .addChoices({ name: 'Assegna', value: 'grant' }, { name: 'Revoca', value: 'revoke' }),
        )
        .addStringOption((o) => o.setName('reason').setDescription('Motivazione')),
    )
    .addSubcommand((sub) =>
      sub
        .setName('friend')
        .setDescription('Assegna o rimuove il ruolo Friend')
        .addUserOption((o) => o.setName('user').setDescription('L’utente').setRequired(true))
        .addStringOption((o) =>
          o
            .setName('action')
            .setDescription('Assegna o rimuovi')
            .setRequired(true)
            .addChoices({ name: 'Assegna', value: 'add' }, { name: 'Rimuovi', value: 'remove' }),
        )
        .addStringOption((o) => o.setName('reason').setDescription('Motivazione')),
    )
    .addSubcommand((sub) =>
      sub
        .setName('mafia')
        .setDescription('Assegna o rimuove il ruolo Mafia')
        .addUserOption((o) => o.setName('user').setDescription('L’utente').setRequired(true))
        .addStringOption((o) =>
          o
            .setName('action')
            .setDescription('Assegna o rimuovi')
            .setRequired(true)
            .addChoices({ name: 'Assegna', value: 'add' }, { name: 'Rimuovi', value: 'remove' }),
        )
        .addStringOption((o) => o.setName('reason').setDescription('Motivazione')),
    )
    .addSubcommand((sub) =>
      sub
        .setName('revoke')
        .setDescription('Revoca l’intero accesso community (Verified + Friend + Mafia)')
        .addUserOption((o) => o.setName('user').setDescription('L’utente').setRequired(true))
        .addStringOption((o) => o.setName('reason').setDescription('Motivazione').setRequired(true))
        .addBooleanOption((o) =>
          o
            .setName('forza')
            .setDescription('Procedi anche se è ancora un membro TTP (sconsigliato)'),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('makettp')
        .setDescription('Fa entrare nella gang un utente della community')
        .addUserOption((o) => o.setName('user').setDescription('L’utente').setRequired(true))
        .addStringOption((o) =>
          o
            .setName('rank')
            .setDescription('Rank iniziale (default: Resident)')
            .addChoices(...RANK_ORDER.map((rank) => ({ name: RANK_LABEL[rank], value: rank }))),
        ),
    )
    .toJSON(),

  async execute(interaction, ctx): Promise<void> {
    await defer(interaction, { ephemeral: true });

    const subcommand = interaction.options.getSubcommand(true);
    const actorId = interaction.user.id;

    try {
      const actor = await ctx.authorization.resolveActor(actorId);

      // --- list ----------------------------------------------------------
      if (subcommand === 'list') {
        await ctx.authorization.require(actor, 'member.info');

        const kind =
          (interaction.options.getString('tipo') as
            'verified' | 'friend' | 'mafia' | 'all' | null) ?? 'all';
        const excludeTtp = interaction.options.getBoolean('escludi-ttp') ?? true;

        const entries = await ctx.community.list({ kind, excludeTtp, limit: 100 });

        if (entries.length === 0) {
          await respond(interaction, {
            embeds: [infoEmbed('Community', 'Nessun utente corrisponde ai filtri.')],
          });
          return;
        }

        const lines = entries.map((entry) => {
          const badges = [
            entry.isTtp ? '🩸' : '',
            entry.isFriend ? '🤝' : '',
            entry.isMafia ? '🕴' : '',
          ]
            .filter(Boolean)
            .join(' ');
          return `• ${escapeMarkdown(entry.displayName)} — <@${entry.discordId}>${badges ? ` ${badges}` : ''}`;
        });

        await respond(interaction, {
          embeds: [
            infoEmbed(`Community · ${entries.length}`, truncate(lines.join('\n'), 4000)).setFooter({
              text: excludeTtp ? 'Membri TTP esclusi' : 'Membri TTP inclusi',
            }),
          ],
        });
        return;
      }

      const targetUser = interaction.options.getUser('user', true);

      // --- info ------------------------------------------------------------
      if (subcommand === 'info') {
        await ctx.authorization.require(actor, 'member.info');
        const canSeeSensitive = (await ctx.authorization.check(actor, 'member.notes.view')).allowed;

        const dossier = await ctx.community.describe(targetUser.id);

        const embed = infoEmbed(`Community · ${escapeMarkdown(targetUser.displayName)}`)
          .setDescription(mention(targetUser.id))
          .addFields(
            {
              name: 'Verified',
              value: dossier.isVerified
                ? `✅ dal ${formatDate(dossier.verification?.verifiedAt)}`
                : '❌ non verificato',
              inline: true,
            },
            {
              name: 'TTP',
              value: dossier.member
                ? `${dossier.isTtp ? '🩸 Sì' : '⚠️ ruolo assente'} · ${STATUS_LABEL[dossier.member.status]}`
                : '— non membro',
              inline: true,
            },
            {
              name: 'Relazioni',
              value:
                [dossier.isFriend ? '🤝 Friend' : '', dossier.isMafia ? '🕴 Mafia' : '']
                  .filter(Boolean)
                  .join('\n') || '—',
              inline: true,
            },
          );

        if (dossier.verification && dossier.verification.rpName !== '—') {
          embed.addFields({
            name: 'Personaggio',
            value: `${escapeMarkdown(dossier.verification.rpName)} ${escapeMarkdown(dossier.verification.rpSurname)} · ID \`${dossier.verification.citizenId}\``,
            inline: false,
          });
        }

        const pending = dossier.applications.find((app) => app.status === 'PENDING');
        embed.addFields({
          name: 'Candidatura TTP',
          value: pending
            ? `⏳ in attesa dal ${formatDate(pending.requestedAt)}`
            : dossier.applications.length > 0
              ? `Ultima: **${dossier.applications[0]?.status}** il ${formatDate(dossier.applications[0]?.requestedAt)}`
              : '—',
          inline: false,
        });

        // Storico blacklist e motivazioni: solo per chi è autorizzato.
        if (canSeeSensitive) {
          embed.addFields({
            name: '🚫 Blacklist',
            value: dossier.blacklist
              ? `**ATTIVA** dal ${formatDate(dossier.blacklist.createdAt)}\nMotivo: ${escapeMarkdown(dossier.blacklist.reason)}`
              : dossier.blacklistHistory.length > 0
                ? `Nessuna attiva · ${dossier.blacklistHistory.length} precedente/i`
                : 'Mai stato in blacklist',
            inline: false,
          });
        }

        await respond(interaction, { embeds: [embed] });
        return;
      }

      // --- Operazioni che mutano lo stato -----------------------------------
      const target = await ctx.authorization.resolveTarget(targetUser.id);
      if (!target) {
        await respond(interaction, {
          embeds: [
            warningEmbed(
              'Utente non presente',
              `${mention(targetUser.id)} non è nel server Discord.`,
            ),
          ],
        });
        return;
      }

      await ctx.authorization.requireOn(actor, target, 'community.manage');

      switch (subcommand) {
        case 'verified': {
          const action = interaction.options.getString('action', true);
          const reason = validateOptionalReason(interaction.options.getString('reason'));

          if (action === 'grant') {
            const result = await ctx.community.grantVerified({
              discordId: targetUser.id,
              actorDiscordId: actorId,
              reason: reason ?? undefined,
            });
            await respond(interaction, {
              embeds: [
                result.alreadyVerified
                  ? warningEmbed('Già verificato', `${mention(targetUser.id)} è già Verified.`)
                  : successEmbed(
                      'Verified assegnato',
                      `${mention(targetUser.id)} ha ottenuto ✅ \`Verified\`.\n\n> Questo **non** lo rende un membro TTP.`,
                    ),
              ],
            });
          } else {
            await ctx.community.revokeVerified({
              discordId: targetUser.id,
              actorDiscordId: actorId,
              reason: reason ?? undefined,
            });
            await respond(interaction, {
              embeds: [
                successEmbed('Verified revocato', `${mention(targetUser.id)} non è più Verified.`),
              ],
            });
          }
          return;
        }

        case 'friend':
        case 'mafia': {
          const grant = interaction.options.getString('action', true) === 'add';
          const reason = validateOptionalReason(interaction.options.getString('reason'));

          const result = await ctx.community.setCommunityRole({
            discordId: targetUser.id,
            actorDiscordId: actorId,
            role: subcommand,
            grant,
            reason: reason ?? undefined,
          });

          const label = subcommand === 'friend' ? '🤝 Friend' : '🕴 Mafia';
          await respond(interaction, {
            embeds: [
              result.changed
                ? successEmbed(
                    grant ? 'Ruolo assegnato' : 'Ruolo rimosso',
                    `${label} · ${mention(targetUser.id)}`,
                  )
                : warningEmbed(
                    'Nessuna modifica',
                    grant
                      ? `${mention(targetUser.id)} ha già ${label}.`
                      : `${mention(targetUser.id)} non ha ${label}.`,
                  ),
            ],
          });
          return;
        }

        case 'revoke': {
          const reason = validateReason(interaction.options.getString('reason', true));
          const force = interaction.options.getBoolean('forza') ?? false;

          await ctx.community.revokeAccess({
            discordId: targetUser.id,
            actorDiscordId: actorId,
            reason,
            force,
          });

          await respond(interaction, {
            embeds: [
              successEmbed(
                'Accesso community revocato',
                `${mention(targetUser.id)} ha perso ✅ \`Verified\`, 🤝 \`Friend\` e 🕴 \`Mafia\`.`,
              ),
            ],
          });
          return;
        }

        case 'makettp': {
          // Stessa authorization di `/member add`: è la stessa operazione.
          await ctx.authorization.requireOn(actor, target, 'member.add');
          const rank =
            (interaction.options.getString('rank') as MemberRank | null) ?? MemberRank.RESIDENT;
          await ctx.authorization.requireRankAssignment(actor, rank);

          const outcome = await ctx.members.addToGang({
            discordId: targetUser.id,
            actorDiscordId: actorId,
            rank,
            recruitedByDiscordId: actorId,
            reason: 'Promosso da community a membro TTP',
            source: 'manual',
          });

          await respond(interaction, {
            embeds: [
              outcome.alreadyMember
                ? warningEmbed('Già membro', `${mention(targetUser.id)} fa già parte della gang.`)
                : successEmbed(
                    'Nuovo membro TTP',
                    `${mention(targetUser.id)}\n\n✅ \`Verified\`\n🩸 \`TTP\`\n${RANK_LABEL[rank]}`,
                  ),
            ],
          });
          return;
        }

        default:
          await respond(interaction, { content: 'Sottocomando non riconosciuto.' });
      }
    } catch (error) {
      await handleInteractionError(interaction, error, {
        operation: `/community ${subcommand}`,
        actorDiscordId: actorId,
      });
    }
  },
};
