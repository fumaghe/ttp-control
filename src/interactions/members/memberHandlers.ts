/**
 * Bottoni e select della member card.
 *
 * Ogni azione ricontrolla i permessi: i bottoni sono stati costruiti in
 * passato, ma il permesso deve valere adesso.
 */
import { ActionRowBuilder, ModalBuilder, StringSelectMenuBuilder } from '@discordjs/builders';
import { TextInputStyle } from 'discord-api-types/v10';
import { SpecialRole } from '../../generated/prisma/enums.js';
import { RANK_LABEL, RANK_ORDER } from '../../config/constants.js';
import { AppError, ERROR_CODE } from '../../errors/AppError.js';
import { handleInteractionError } from '../../errors/handleInteractionError.js';
import { SPECIAL_ROLE_LABEL, STATUS_LABEL } from '../../components/embeds/memberCard.js';
import { infoEmbed, mention, successEmbed, warningEmbed } from '../../components/embeds/base.js';
import type { ComponentHandler, ModalHandler } from '../../types/command.js';
import { textField } from '../../components/modals/fields.js';
import { buildCustomId, requireArg } from '../../utils/customId.js';
import { defer, respond } from '../../utils/respond.js';
import {
  validateOptionalNotes,
  validateReason,
  validateSnowflake,
} from '../../utils/validation.js';

/** Modal per la motivazione di un'operazione avviata da bottone. */
function reasonModal(action: string, discordId: string, title: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(buildCustomId('member', `${action}Submit`, discordId))
    .setTitle(title)
    .addLabelComponents(
      textField({
        customId: 'reason',
        label: 'Motivazione',
        style: TextInputStyle.Paragraph,
        minLength: 3,
        maxLength: 500,
      }),
    );
}

/** Le azioni che richiedono una motivazione passano da un modal. */
const REASON_ACTIONS: Readonly<Record<string, string>> = {
  promote: 'Promozione',
  demote: 'Retrocessione',
  remove: 'Rimozione dalla gang',
};

export const memberButtonHandler: ComponentHandler = {
  namespace: 'member',

  async handle(interaction, parsed, ctx): Promise<void> {
    const actorId = interaction.user.id;

    // --- Select dei ruoli speciali --------------------------------------
    if (interaction.isStringSelectMenu() && parsed.action === 'rolesSelect') {
      await defer(interaction, { ephemeral: true });
      try {
        const targetId = validateSnowflake(requireArg(parsed, 0, 'l’utente'));
        const actor = await ctx.authorization.resolveActor(actorId);
        const target = await ctx.authorization.resolveTarget(targetId);
        if (!target) {
          throw new AppError(ERROR_CODE.TARGET_LEFT_GUILD, 'L’utente non è più nel server.');
        }
        await ctx.authorization.requireOn(actor, target, 'member.specialRoles');

        const member = await ctx.members.requireInGang(targetId);
        const current = new Set(await ctx.members.listSpecialRoles(member.id));
        const wanted = new Set(interaction.values as SpecialRole[]);

        const toAdd = [...wanted].filter((role) => !current.has(role));
        const toRemove = [...current].filter((role) => !wanted.has(role));

        for (const role of toAdd) {
          await ctx.members.addSpecialRole({ discordId: targetId, actorDiscordId: actorId, role });
        }
        for (const role of toRemove) {
          await ctx.members.removeSpecialRole({
            discordId: targetId,
            actorDiscordId: actorId,
            role,
          });
        }

        const lines = [
          toAdd.length > 0
            ? `**Assegnati**\n${toAdd.map((r) => SPECIAL_ROLE_LABEL[r]).join('\n')}`
            : '',
          toRemove.length > 0
            ? `**Rimossi**\n${toRemove.map((r) => SPECIAL_ROLE_LABEL[r]).join('\n')}`
            : '',
        ].filter(Boolean);

        await respond(interaction, {
          embeds: [
            lines.length > 0
              ? successEmbed('Ruoli aggiornati', lines.join('\n\n'))
              : warningEmbed('Nessuna modifica', 'La selezione coincide con i ruoli attuali.'),
          ],
        });
      } catch (error) {
        await handleInteractionError(interaction, error, {
          operation: 'select:member:roles',
          actorDiscordId: actorId,
        });
      }
      return;
    }

    if (!interaction.isButton()) return;

    const targetId = validateSnowflake(requireArg(parsed, 0, 'l’utente'));

    // --- Azioni che aprono un modal (nessun defer prima di showModal) ----
    const reasonTitle = REASON_ACTIONS[parsed.action];
    if (reasonTitle !== undefined) {
      try {
        const actor = await ctx.authorization.resolveActor(actorId);
        const target = await ctx.authorization.resolveTarget(targetId);
        if (!target) {
          throw new AppError(ERROR_CODE.TARGET_LEFT_GUILD, 'L’utente non è più nel server.');
        }

        const operation =
          parsed.action === 'promote'
            ? 'member.promote'
            : parsed.action === 'demote'
              ? 'member.demote'
              : 'member.remove';
        await ctx.authorization.requireOn(actor, target, operation);

        await interaction.responder.showModal(reasonModal(parsed.action, targetId, reasonTitle));
      } catch (error) {
        await handleInteractionError(interaction, error, {
          operation: `button:member:${parsed.action}`,
          actorDiscordId: actorId,
          targetDiscordId: targetId,
        });
      }
      return;
    }

    if (parsed.action === 'notes') {
      try {
        const actor = await ctx.authorization.resolveActor(actorId);
        const target = await ctx.authorization.resolveTarget(targetId);
        if (!target) {
          throw new AppError(ERROR_CODE.TARGET_LEFT_GUILD, 'L’utente non è più nel server.');
        }
        await ctx.authorization.requireOn(actor, target, 'member.status');

        const member = await ctx.members.requireInGang(targetId);

        await interaction.responder.showModal(
          new ModalBuilder()
            .setCustomId(buildCustomId('member', 'notesSubmit', targetId))
            .setTitle('Note della Leadership')
            .addLabelComponents(
              textField({
                customId: 'notes',
                label: 'Note',
                description: 'Lascia vuoto per cancellarle',
                style: TextInputStyle.Paragraph,
                maxLength: 1000,
                required: false,
                value: member.notes ?? '',
              }),
            ),
        );
      } catch (error) {
        await handleInteractionError(interaction, error, {
          operation: 'button:member:notes',
          actorDiscordId: actorId,
          targetDiscordId: targetId,
        });
      }
      return;
    }

    // --- Azioni immediate -------------------------------------------------
    await defer(interaction, { ephemeral: true });

    try {
      const actor = await ctx.authorization.resolveActor(actorId);
      const target = await ctx.authorization.resolveTarget(targetId);
      if (!target) {
        throw new AppError(ERROR_CODE.TARGET_LEFT_GUILD, 'L’utente non è più nel server.');
      }

      switch (parsed.action) {
        case 'inactive':
        case 'active': {
          await ctx.authorization.requireOn(actor, target, 'member.status');
          const outcome =
            parsed.action === 'inactive'
              ? await ctx.members.setInactive({ discordId: targetId, actorDiscordId: actorId })
              : await ctx.members.setActive({ discordId: targetId, actorDiscordId: actorId });

          await respond(interaction, {
            embeds: [
              outcome.changed
                ? successEmbed(
                    'Stato aggiornato',
                    `${mention(targetId)} → ${STATUS_LABEL[outcome.member.status]}\n\nMembership, rank e badge restano invariati.`,
                  )
                : warningEmbed(
                    'Nessuna modifica',
                    `${mention(targetId)} è già ${STATUS_LABEL[outcome.member.status]}.`,
                  ),
            ],
          });
          return;
        }

        case 'roles': {
          await ctx.authorization.requireOn(actor, target, 'member.specialRoles');
          const member = await ctx.members.requireInGang(targetId);
          const current = new Set(await ctx.members.listSpecialRoles(member.id));

          const select = new StringSelectMenuBuilder()
            .setCustomId(buildCustomId('member', 'rolesSelect', targetId))
            .setPlaceholder('Seleziona i ruoli speciali da mantenere')
            .setMinValues(0)
            .setMaxValues(Object.keys(SpecialRole).length)
            .addOptions(
              Object.values(SpecialRole).map((role) => ({
                label: SPECIAL_ROLE_LABEL[role],
                value: role,
                default: current.has(role),
              })),
            );

          await respond(interaction, {
            embeds: [
              infoEmbed(
                'Ruoli speciali',
                `${mention(targetId)}\n\nLa selezione finale sostituisce quella attuale.\nMembership, rank e stato non vengono toccati.`,
              ),
            ],
            components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
          });
          return;
        }

        default:
          await respond(interaction, { content: 'Azione non riconosciuta.' });
      }
    } catch (error) {
      await handleInteractionError(interaction, error, {
        operation: `button:member:${parsed.action}`,
        actorDiscordId: actorId,
        targetDiscordId: targetId,
      });
    }
  },
};

export const memberModalHandler: ModalHandler = {
  namespace: 'member',

  async handle(interaction, parsed, ctx): Promise<void> {
    await defer(interaction, { ephemeral: true });

    const actorId = interaction.user.id;
    const targetId = validateSnowflake(requireArg(parsed, 0, 'l’utente'));

    try {
      const actor = await ctx.authorization.resolveActor(actorId);
      const target = await ctx.authorization.resolveTarget(targetId);
      if (!target) {
        throw new AppError(ERROR_CODE.TARGET_LEFT_GUILD, 'L’utente non è più nel server.');
      }

      switch (parsed.action) {
        case 'promoteSubmit': {
          await ctx.authorization.requireOn(actor, target, 'member.promote');
          const reason = validateReason(interaction.fields.getTextInputValue('reason'));

          const current = await ctx.members.requireInGang(targetId);
          const destination = RANK_ORDER[RANK_ORDER.indexOf(current.rank) + 1];
          if (destination === undefined) {
            throw new AppError(
              ERROR_CODE.RANK_AT_MAXIMUM,
              `Il membro è già **${RANK_LABEL[current.rank]}**, il rank più alto.`,
            );
          }
          await ctx.authorization.requireRankAssignment(actor, destination);

          const outcome = await ctx.members.promote({
            discordId: targetId,
            actorDiscordId: actorId,
            reason,
          });

          await respond(interaction, {
            embeds: [
              successEmbed(
                'Promozione applicata',
                `${mention(targetId)}\n\n${RANK_LABEL[outcome.fromRank]} → **${RANK_LABEL[outcome.toRank]}**`,
              ),
            ],
          });
          return;
        }

        case 'demoteSubmit': {
          await ctx.authorization.requireOn(actor, target, 'member.demote');
          const reason = validateReason(interaction.fields.getTextInputValue('reason'));

          const outcome = await ctx.members.demote({
            discordId: targetId,
            actorDiscordId: actorId,
            reason,
          });

          await respond(interaction, {
            embeds: [
              successEmbed(
                'Retrocessione applicata',
                `${mention(targetId)}\n\n${RANK_LABEL[outcome.fromRank]} → **${RANK_LABEL[outcome.toRank]}**`,
              ),
            ],
          });
          return;
        }

        case 'removeSubmit': {
          await ctx.authorization.requireOn(actor, target, 'member.remove');
          const reason = validateReason(interaction.fields.getTextInputValue('reason'));

          const outcome = await ctx.members.removeFromGang({
            discordId: targetId,
            actorDiscordId: actorId,
            reason,
          });

          await respond(interaction, {
            embeds: [
              successEmbed(
                'Membro rimosso dalla gang',
                [
                  `${mention(targetId)} non fa più parte dei TTP.`,
                  '',
                  `🩸 \`TTP\` e ${RANK_LABEL[outcome.member.rank]} rimossi`,
                  '✅ `Verified` **mantenuto**',
                  '',
                  'Non è stato espulso dal Discord.',
                ].join('\n'),
              ),
            ],
          });
          return;
        }

        case 'notesSubmit': {
          await ctx.authorization.requireOn(actor, target, 'member.status');
          const notes = validateOptionalNotes(interaction.fields.getTextInputValue('notes'));

          await ctx.members.setNotes({
            discordId: targetId,
            actorDiscordId: actorId,
            notes,
          });

          await respond(interaction, {
            embeds: [
              successEmbed(
                notes === null ? 'Note cancellate' : 'Note aggiornate',
                mention(targetId),
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
        operation: `modal:member:${parsed.action}`,
        actorDiscordId: actorId,
        targetDiscordId: targetId,
      });
    }
  },
};
