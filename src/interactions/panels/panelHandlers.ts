/**
 * Bottoni del control panel e paginazione del roster.
 */
import { ModalBuilder } from '@discordjs/builders';
import { TextInputStyle } from 'discord-api-types/v10';
import { MemberStatus, type MemberRank } from '../../generated/prisma/enums.js';
import { RANK_LABEL } from '../../config/constants.js';
import { buildControlPanel } from '../../components/embeds/controlPanel.js';
import {
  buildRosterControls,
  buildRosterPages,
  decodeFilterToken,
  encodeFilterToken,
} from '../../components/embeds/roster.js';
import { buildMemberCard, STATUS_LABEL } from '../../components/embeds/memberCard.js';
import {
  escapeMarkdown,
  formatDate,
  infoEmbed,
  mention,
  truncate,
  warningEmbed,
} from '../../components/embeds/base.js';
import { handleInteractionError } from '../../errors/handleInteractionError.js';
import { fetchRoster } from '../../commands/roster.js';
import type { ComponentHandler, ModalHandler } from '../../types/command.js';
import { textField } from '../../components/modals/fields.js';
import { buildCustomId, requireArg } from '../../utils/customId.js';
import { defer, respond } from '../../utils/respond.js';
import { validateText } from '../../utils/validation.js';

export const panelButtonHandler: ComponentHandler = {
  namespace: 'panel',

  async handle(interaction, parsed, ctx): Promise<void> {
    if (!interaction.isButton()) return;
    const actorId = interaction.user.id;

    // SEARCH apre un modal: niente defer prima di `showModal`.
    if (parsed.action === 'search') {
      try {
        const actor = await ctx.authorization.resolveActor(actorId);
        await ctx.authorization.require(actor, 'panel.use');

        await interaction.responder.showModal(
          new ModalBuilder()
            .setCustomId(buildCustomId('panel', 'searchSubmit'))
            .setTitle('Cerca un membro')
            .addLabelComponents(
              textField({
                customId: 'query',
                label: 'Nome IC, cognome o Citizen ID',
                style: TextInputStyle.Short,
                minLength: 2,
                maxLength: 64,
              }),
            ),
        );
      } catch (error) {
        await handleInteractionError(interaction, error, {
          operation: 'button:panel:search',
          actorDiscordId: actorId,
        });
      }
      return;
    }

    await defer(interaction, { ephemeral: true });

    try {
      const actor = await ctx.authorization.resolveActor(actorId);
      await ctx.authorization.require(actor, 'panel.use');

      switch (parsed.action) {
        case 'refresh': {
          const stats = await ctx.stats.dashboard();
          const panel = buildControlPanel(stats);
          await respond(interaction, {
            embeds: panel.embeds ?? [],
            components: panel.components ?? [],
          });
          return;
        }

        case 'members':
        case 'roster': {
          const members = await ctx.members.roster({
            statusIn: [MemberStatus.ACTIVE, MemberStatus.INACTIVE],
          });
          const pages = buildRosterPages(members, {});
          const first = pages[0];
          if (!first) {
            await respond(interaction, { content: 'Nessun membro registrato.' });
            return;
          }
          await respond(interaction, {
            embeds: [first.embed],
            components: buildRosterControls(0, first.totalPages, encodeFilterToken(null, null)),
          });
          return;
        }

        case 'community': {
          const entries = await ctx.community.list({
            kind: 'all',
            excludeTtp: true,
            limit: 60,
          });
          await respond(interaction, {
            embeds: [
              infoEmbed(
                `Community · ${entries.length}`,
                entries.length === 0
                  ? 'Nessun utente community registrato.'
                  : truncate(
                      entries
                        .map(
                          (entry) =>
                            `• ${escapeMarkdown(entry.displayName)} — <@${entry.discordId}>${entry.isFriend ? ' 🤝' : ''}${entry.isMafia ? ' 🕴' : ''}`,
                        )
                        .join('\n'),
                      4000,
                    ),
              ).setFooter({ text: 'Membri TTP esclusi' }),
            ],
          });
          return;
        }

        case 'requests': {
          const pending = await ctx.applications.listPending({ take: 20 });
          if (pending.length === 0) {
            await respond(interaction, {
              embeds: [infoEmbed('Candidature TTP', 'Nessuna candidatura in attesa.')],
            });
            return;
          }

          await respond(interaction, {
            embeds: [
              infoEmbed(
                `Candidature in attesa · ${pending.length}`,
                truncate(
                  pending
                    .map(
                      (application) =>
                        `• <@${application.discordId}> — dal ${formatDate(application.requestedAt)}`,
                    )
                    .join('\n'),
                  4000,
                ),
              ).setFooter({ text: `Revisionale in #${ctx.channels.ttpRequests}` }),
            ],
          });
          return;
        }

        case 'blacklist': {
          await ctx.authorization.require(actor, 'blacklist.manage');
          const entries = await ctx.blacklist.listActive({ take: 30 });
          await respond(interaction, {
            embeds: [
              infoEmbed(
                `Blacklist attive · ${entries.length}`,
                entries.length === 0
                  ? 'Nessun utente in blacklist.'
                  : truncate(
                      entries
                        .map((entry) => `• <@${entry.discordId}> — ${escapeMarkdown(entry.reason)}`)
                        .join('\n'),
                      4000,
                    ),
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
        operation: `button:panel:${parsed.action}`,
        actorDiscordId: actorId,
      });
    }
  },
};

export const panelModalHandler: ModalHandler = {
  namespace: 'panel',

  async handle(interaction, parsed, ctx): Promise<void> {
    if (parsed.action !== 'searchSubmit') return;
    await defer(interaction, { ephemeral: true });

    const actorId = interaction.user.id;
    try {
      const actor = await ctx.authorization.resolveActor(actorId);
      await ctx.authorization.require(actor, 'panel.use');
      const canSeeNotes = (await ctx.authorization.check(actor, 'member.notes.view')).allowed;

      const query = validateText(interaction.fields.getTextInputValue('query'), {
        label: 'Ricerca',
        min: 2,
        max: 64,
      }).toLowerCase();

      const members = await ctx.members.roster();
      const matches = members.filter((member) =>
        [member.rpName, member.rpSurname, member.citizenId]
          .filter((value): value is string => typeof value === 'string')
          .some((value) => value.toLowerCase().includes(query)),
      );

      if (matches.length === 0) {
        await respond(interaction, {
          embeds: [warningEmbed('Nessun risultato', `Nessun membro corrisponde a “${query}”.`)],
        });
        return;
      }

      // Un solo risultato: mostriamo direttamente la scheda completa.
      const single = matches[0];
      if (matches.length === 1 && single) {
        const specialRoles = await ctx.members.listSpecialRoles(single.id);
        const snapshot = await ctx.gateway.fetchMember(single.discordId);
        await respond(interaction, {
          embeds: [
            buildMemberCard({
              member: single,
              displayName: snapshot?.displayName ?? single.discordId,
              specialRoles,
              includeNotes: canSeeNotes,
            }),
          ],
        });
        return;
      }

      await respond(interaction, {
        embeds: [
          infoEmbed(
            `Risultati · ${matches.length}`,
            truncate(
              matches
                .slice(0, 25)
                .map(
                  (member) =>
                    `• ${escapeMarkdown([member.rpName, member.rpSurname].filter(Boolean).join(' '))} — ${mention(member.discordId)} · ${RANK_LABEL[member.rank]} · ${STATUS_LABEL[member.status]}`,
                )
                .join('\n'),
              4000,
            ),
          ),
        ],
      });
    } catch (error) {
      await handleInteractionError(interaction, error, {
        operation: 'modal:panel:search',
        actorDiscordId: actorId,
      });
    }
  },
};

export const rosterButtonHandler: ComponentHandler = {
  namespace: 'roster',

  async handle(interaction, parsed, ctx): Promise<void> {
    if (!interaction.isButton()) return;
    if (parsed.action === 'noop') {
      await interaction.responder.deferUpdate();
      return;
    }
    if (parsed.action !== 'page') return;

    await defer(interaction, { ephemeral: true });
    const actorId = interaction.user.id;

    try {
      const actor = await ctx.authorization.resolveActor(actorId);
      await ctx.authorization.require(actor, 'roster.view');

      const pageIndex = Number.parseInt(requireArg(parsed, 0, 'la pagina'), 10);
      const token = requireArg(parsed, 1, 'i filtri');
      const filters = decodeFilterToken(token);

      // Il roster viene ricalcolato a ogni click: nessuno stato in memoria da
      // perdere al restart, e i dati sono sempre aggiornati.
      const members = await fetchRoster(ctx, {
        rank: filters.rank as MemberRank | null,
        status: filters.status as MemberStatus | null,
        roleId: null,
      });

      const pages = buildRosterPages(members, {
        rank: filters.rank ? RANK_LABEL[filters.rank as MemberRank] : undefined,
        status: filters.status ? STATUS_LABEL[filters.status as MemberStatus] : undefined,
      });

      const safeIndex = Math.min(
        Math.max(Number.isNaN(pageIndex) ? 0 : pageIndex, 0),
        pages.length - 1,
      );
      const page = pages[safeIndex];
      if (!page) {
        await respond(interaction, { content: 'Pagina non disponibile.' });
        return;
      }

      await respond(interaction, {
        embeds: [page.embed],
        components: buildRosterControls(safeIndex, page.totalPages, token),
      });
    } catch (error) {
      await handleInteractionError(interaction, error, {
        operation: 'button:roster:page',
        actorDiscordId: actorId,
      });
    }
  },
};
