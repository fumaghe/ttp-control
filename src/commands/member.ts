/**
 * `/member` — gestione operativa dei membri della gang.
 *
 * Ogni sottocomando segue la stessa sequenza:
 *   VALIDATE → AUTHORIZE → CHECK STATE → EXECUTE → PERSIST → AUDIT → RESPOND
 *
 * La logica vive nei service: qui si traduce fra Discord e dominio.
 */
import { SlashCommandBuilder } from '@discordjs/builders';
import { PermissionFlagsBits } from 'discord-api-types/v10';
import { MemberRank, MemberStatus, SpecialRole } from '../generated/prisma/enums.js';
import { RANK_LABEL, RANK_ORDER } from '../config/constants.js';
import { can, canActOn, canAssignRank, type Operation } from '../config/permissions.js';
import { AppError, ERROR_CODE } from '../errors/AppError.js';
import { handleInteractionError } from '../errors/handleInteractionError.js';
import {
  buildMemberActions,
  buildMemberCard,
  SPECIAL_ROLE_LABEL,
  STATUS_LABEL,
} from '../components/embeds/memberCard.js';
import { successEmbed, warningEmbed, mention } from '../components/embeds/base.js';
import type { SlashCommand } from '../types/command.js';
import type { AppContext } from '../types/context.js';
import { defer, respond } from '../utils/respond.js';
import { validateOptionalNotes, validateReason } from '../utils/validation.js';

const RANK_CHOICES = RANK_ORDER.map((rank) => ({ name: RANK_LABEL[rank], value: rank }));

const SPECIAL_ROLE_CHOICES = Object.values(SpecialRole).map((role) => ({
  name: SPECIAL_ROLE_LABEL[role],
  value: role,
}));

/** Costruisce i flag dei bottoni della member card per un dato attore. */
async function actionFlagsFor(
  ctx: AppContext,
  actorId: string,
  targetId: string,
  rank: MemberRank,
): Promise<{
  canPromote: boolean;
  canDemote: boolean;
  canManageRoles: boolean;
  canChangeStatus: boolean;
  canEditNotes: boolean;
  canRemove: boolean;
  canViewNotes: boolean;
}> {
  const actor = await ctx.authorization.resolveActor(actorId);
  const target = await ctx.authorization.resolveTarget(targetId);
  const policy = await ctx.authorization.policy();

  if (!target) {
    return {
      canPromote: false,
      canDemote: false,
      canManageRoles: false,
      canChangeStatus: false,
      canEditNotes: false,
      canRemove: false,
      canViewNotes: false,
    };
  }

  const allow = (op: Operation): boolean => canActOn(actor, target, op, policy).allowed;

  const nextIndex = RANK_ORDER.indexOf(rank) + 1;
  const nextRankValue = RANK_ORDER[nextIndex];

  return {
    canPromote:
      nextRankValue !== undefined &&
      allow('member.promote') &&
      canAssignRank(actor, nextRankValue, policy).allowed,
    canDemote: RANK_ORDER.indexOf(rank) > 0 && allow('member.demote'),
    canManageRoles: allow('member.specialRoles'),
    canChangeStatus: allow('member.status'),
    canEditNotes: allow('member.status'),
    canRemove: allow('member.remove'),
    canViewNotes: can(actor, 'member.notes.view', policy).allowed,
  };
}

export const memberCommand: SlashCommand = {
  name: 'member',

  data: new SlashCommandBuilder()
    .setName('member')
    .setDescription('Gestione dei membri della gang TTP')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addSubcommand((sub) =>
      sub
        .setName('info')
        .setDescription('Mostra la scheda di un membro')
        .addUserOption((o) => o.setName('user').setDescription('Il membro').setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Aggiunge manualmente un utente alla gang')
        .addUserOption((o) => o.setName('user').setDescription('L’utente').setRequired(true))
        .addStringOption((o) =>
          o
            .setName('rank')
            .setDescription('Rank iniziale (default: Resident)')
            .addChoices(...RANK_CHOICES),
        )
        .addUserOption((o) => o.setName('recruiter').setDescription('Chi lo ha reclutato'))
        .addStringOption((o) => o.setName('notes').setDescription('Note della Leadership')),
    )
    .addSubcommand((sub) =>
      sub
        .setName('promote')
        .setDescription('Promuove al rank immediatamente superiore')
        .addUserOption((o) => o.setName('user').setDescription('Il membro').setRequired(true))
        .addStringOption((o) =>
          o.setName('reason').setDescription('Motivazione').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('demote')
        .setDescription('Retrocede al rank immediatamente inferiore')
        .addUserOption((o) => o.setName('user').setDescription('Il membro').setRequired(true))
        .addStringOption((o) =>
          o.setName('reason').setDescription('Motivazione').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('rank')
        .setDescription('Cambio rank diretto (straordinario)')
        .addUserOption((o) => o.setName('user').setDescription('Il membro').setRequired(true))
        .addStringOption((o) =>
          o
            .setName('rank')
            .setDescription('Nuovo rank')
            .setRequired(true)
            .addChoices(...RANK_CHOICES),
        )
        .addStringOption((o) =>
          o.setName('reason').setDescription('Motivazione').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('roles')
        .setDescription('Assegna o rimuove badge e specializzazioni')
        .addUserOption((o) => o.setName('user').setDescription('Il membro').setRequired(true))
        .addStringOption((o) =>
          o
            .setName('role')
            .setDescription('Il ruolo speciale')
            .setRequired(true)
            .addChoices(...SPECIAL_ROLE_CHOICES),
        )
        .addStringOption((o) =>
          o
            .setName('action')
            .setDescription('Assegna o rimuovi')
            .setRequired(true)
            .addChoices({ name: 'Assegna', value: 'add' }, { name: 'Rimuovi', value: 'remove' }),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('status')
        .setDescription('Mostra lo stato di membership di un utente')
        .addUserOption((o) => o.setName('user').setDescription('L’utente').setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('inactive')
        .setDescription('Imposta un membro come inattivo (mantiene TTP e rank)')
        .addUserOption((o) => o.setName('user').setDescription('Il membro').setRequired(true))
        .addStringOption((o) => o.setName('reason').setDescription('Motivazione')),
    )
    .addSubcommand((sub) =>
      sub
        .setName('active')
        .setDescription('Riporta un membro allo stato attivo')
        .addUserOption((o) => o.setName('user').setDescription('Il membro').setRequired(true))
        .addStringOption((o) => o.setName('reason').setDescription('Motivazione')),
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Rimuove dalla gang (NON dal Discord, mantiene Verified)')
        .addUserOption((o) => o.setName('user').setDescription('Il membro').setRequired(true))
        .addStringOption((o) =>
          o.setName('reason').setDescription('Motivazione').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('permadeath')
        .setDescription('Marca un membro come permadeath (irreversibile)')
        .addUserOption((o) => o.setName('user').setDescription('Il membro').setRequired(true))
        .addStringOption((o) => o.setName('reason').setDescription('Motivazione').setRequired(true))
        .addBooleanOption((o) =>
          o
            .setName('conferma')
            .setDescription('Devi impostarlo su true per confermare')
            .setRequired(true),
        ),
    )
    .toJSON(),

  async execute(interaction, ctx): Promise<void> {
    await defer(interaction, { ephemeral: true });

    const subcommand = interaction.options.getSubcommand(true);
    const targetUser = interaction.options.getUser('user', true);
    const actorId = interaction.user.id;

    try {
      const actor = await ctx.authorization.resolveActor(actorId);

      // --- info / status: sola lettura ---------------------------------
      if (subcommand === 'info' || subcommand === 'status') {
        await ctx.authorization.require(actor, 'member.info');

        const member = await ctx.members.find(targetUser.id);
        if (!member) {
          await respond(interaction, {
            embeds: [
              warningEmbed(
                'Nessun record di membership',
                `${mention(targetUser.id)} non risulta (e non è mai risultato) membro della gang.`,
              ),
            ],
          });
          return;
        }

        const flags = await actionFlagsFor(ctx, actorId, targetUser.id, member.rank);
        const specialRoles = await ctx.members.listSpecialRoles(member.id);

        const embed = buildMemberCard({
          member,
          displayName: targetUser.displayName,
          specialRoles,
          includeNotes: flags.canViewNotes,
        });

        const components =
          subcommand === 'info' &&
          (member.status === MemberStatus.ACTIVE || member.status === MemberStatus.INACTIVE)
            ? buildMemberActions(targetUser.id, flags, member.status)
            : [];

        await respond(interaction, { embeds: [embed], components });
        return;
      }

      // --- Da qui in poi tutte le operazioni mutano lo stato ------------
      const target = await ctx.authorization.resolveTarget(targetUser.id);
      if (!target) {
        throw new AppError(
          ERROR_CODE.TARGET_LEFT_GUILD,
          'Questo utente non è presente nel server Discord.',
        );
      }

      switch (subcommand) {
        case 'add': {
          await ctx.authorization.requireOn(actor, target, 'member.add');

          const rank =
            (interaction.options.getString('rank') as MemberRank | null) ?? MemberRank.RESIDENT;
          await ctx.authorization.requireRankAssignment(actor, rank);

          const recruiter = interaction.options.getUser('recruiter');
          const notes = validateOptionalNotes(interaction.options.getString('notes'));

          const outcome = await ctx.members.addToGang({
            discordId: targetUser.id,
            actorDiscordId: actorId,
            rank,
            recruitedByDiscordId: recruiter?.id ?? actorId,
            notes: notes ?? undefined,
            reason: 'Aggiunta manuale dalla Leadership',
            source: 'manual',
          });

          if (outcome.alreadyMember) {
            await respond(interaction, {
              embeds: [
                warningEmbed(
                  'Già membro',
                  `${mention(targetUser.id)} fa già parte della gang come **${RANK_LABEL[outcome.member.rank]}**.\nI ruoli Discord sono stati riallineati.`,
                ),
              ],
            });
            return;
          }

          const embed = successEmbed(
            'Membro aggiunto',
            [
              `${mention(targetUser.id)} è ora un membro della gang.`,
              '',
              '✅ `Verified`',
              '🩸 `TTP`',
              RANK_LABEL[rank],
            ].join('\n'),
          );

          if (outcome.warnings.length > 0) {
            embed.addFields({
              name: '⚠️ Da controllare',
              value: outcome.warnings.join('\n'),
            });
          }

          await respond(interaction, { embeds: [embed] });
          return;
        }

        case 'promote': {
          await ctx.authorization.requireOn(actor, target, 'member.promote');
          const reason = validateReason(interaction.options.getString('reason', true));

          // Il rank di destinazione va autorizzato PRIMA di applicarlo:
          // un Big non deve poter creare altri Big.
          const current = await ctx.members.requireInGang(targetUser.id);
          const nextIndex = RANK_ORDER.indexOf(current.rank) + 1;
          const destination = RANK_ORDER[nextIndex];
          if (destination === undefined) {
            throw new AppError(
              ERROR_CODE.RANK_AT_MAXIMUM,
              `Il membro è già **${RANK_LABEL[current.rank]}**, il rank più alto.`,
            );
          }
          await ctx.authorization.requireRankAssignment(actor, destination);

          const outcome = await ctx.members.promote({
            discordId: targetUser.id,
            actorDiscordId: actorId,
            reason,
          });

          await respond(interaction, {
            embeds: [
              successEmbed(
                'Promozione applicata',
                `${mention(targetUser.id)}\n\n${RANK_LABEL[outcome.fromRank]} → **${RANK_LABEL[outcome.toRank]}**`,
              ),
            ],
          });
          return;
        }

        case 'demote': {
          await ctx.authorization.requireOn(actor, target, 'member.demote');
          const reason = validateReason(interaction.options.getString('reason', true));

          const outcome = await ctx.members.demote({
            discordId: targetUser.id,
            actorDiscordId: actorId,
            reason,
          });

          await respond(interaction, {
            embeds: [
              successEmbed(
                'Retrocessione applicata',
                `${mention(targetUser.id)}\n\n${RANK_LABEL[outcome.fromRank]} → **${RANK_LABEL[outcome.toRank]}**`,
              ),
            ],
          });
          return;
        }

        case 'rank': {
          await ctx.authorization.requireOn(actor, target, 'member.rank');
          const rank = interaction.options.getString('rank', true) as MemberRank;
          await ctx.authorization.requireRankAssignment(actor, rank);
          const reason = validateReason(interaction.options.getString('reason', true));

          const outcome = await ctx.members.setRank({
            discordId: targetUser.id,
            actorDiscordId: actorId,
            rank,
            reason,
          });

          await respond(interaction, {
            embeds: [
              successEmbed(
                'Rank aggiornato',
                `${mention(targetUser.id)}\n\n${RANK_LABEL[outcome.fromRank]} → **${RANK_LABEL[outcome.toRank]}**`,
              ),
            ],
          });
          return;
        }

        case 'roles': {
          await ctx.authorization.requireOn(actor, target, 'member.specialRoles');
          const role = interaction.options.getString('role', true) as SpecialRole;
          const action = interaction.options.getString('action', true);

          const changed =
            action === 'add'
              ? await ctx.members.addSpecialRole({
                  discordId: targetUser.id,
                  actorDiscordId: actorId,
                  role,
                })
              : await ctx.members.removeSpecialRole({
                  discordId: targetUser.id,
                  actorDiscordId: actorId,
                  role,
                });

          await respond(interaction, {
            embeds: [
              changed
                ? successEmbed(
                    action === 'add' ? 'Ruolo assegnato' : 'Ruolo rimosso',
                    `${SPECIAL_ROLE_LABEL[role]} · ${mention(targetUser.id)}`,
                  )
                : warningEmbed(
                    'Nessuna modifica',
                    action === 'add'
                      ? `${mention(targetUser.id)} ha già ${SPECIAL_ROLE_LABEL[role]}.`
                      : `${mention(targetUser.id)} non ha ${SPECIAL_ROLE_LABEL[role]}.`,
                  ),
            ],
          });
          return;
        }

        case 'inactive':
        case 'active': {
          await ctx.authorization.requireOn(actor, target, 'member.status');
          const reason = interaction.options.getString('reason') ?? undefined;

          const outcome =
            subcommand === 'inactive'
              ? await ctx.members.setInactive({
                  discordId: targetUser.id,
                  actorDiscordId: actorId,
                  reason,
                })
              : await ctx.members.setActive({
                  discordId: targetUser.id,
                  actorDiscordId: actorId,
                  reason,
                });

          await respond(interaction, {
            embeds: [
              outcome.changed
                ? successEmbed(
                    'Stato aggiornato',
                    [
                      `${mention(targetUser.id)} → ${STATUS_LABEL[outcome.member.status]}`,
                      '',
                      'Membership, rank, badge e specializzazioni restano invariati.',
                    ].join('\n'),
                  )
                : warningEmbed(
                    'Nessuna modifica',
                    `${mention(targetUser.id)} è già ${STATUS_LABEL[outcome.member.status]}.`,
                  ),
            ],
          });
          return;
        }

        case 'remove': {
          await ctx.authorization.requireOn(actor, target, 'member.remove');
          const reason = validateReason(interaction.options.getString('reason', true));

          const outcome = await ctx.members.removeFromGang({
            discordId: targetUser.id,
            actorDiscordId: actorId,
            reason,
          });

          const embed = successEmbed(
            'Membro rimosso dalla gang',
            [
              `${mention(targetUser.id)} non fa più parte dei TTP.`,
              '',
              '🩸 `TTP` rimosso',
              `${RANK_LABEL[outcome.member.rank]} rimosso`,
              '✅ `Verified` **mantenuto**',
              '',
              'Non è stato espulso dal Discord e lo storico è intatto.',
            ].join('\n'),
          );

          if (outcome.removedSpecialRoles.length > 0) {
            embed.addFields({
              name: 'Ruoli speciali rimossi',
              value: outcome.removedSpecialRoles.map((role) => SPECIAL_ROLE_LABEL[role]).join('\n'),
            });
          }

          await respond(interaction, { embeds: [embed] });
          return;
        }

        case 'permadeath': {
          await ctx.authorization.requireOn(actor, target, 'member.permadeath');

          if (!interaction.options.getBoolean('conferma', true)) {
            await respond(interaction, {
              embeds: [
                warningEmbed(
                  'Conferma richiesta',
                  'Il permadeath è un’operazione molto sensibile.\nRiesegui il comando con `conferma: true`.',
                ),
              ],
            });
            return;
          }

          const reason = validateReason(interaction.options.getString('reason', true));
          const outcome = await ctx.members.permadeath({
            discordId: targetUser.id,
            actorDiscordId: actorId,
            reason,
          });

          await respond(interaction, {
            embeds: [
              successEmbed(
                'Permadeath registrato',
                [
                  `${mention(targetUser.id)} è stato marcato come **permadeath**.`,
                  '',
                  '🩸 `TTP` rimosso',
                  `${RANK_LABEL[outcome.member.rank]} rimosso`,
                  '💀 `Permadeath` assegnato',
                  '',
                  'Lo storico del personaggio è stato interamente conservato.',
                ].join('\n'),
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
        operation: `/member ${subcommand}`,
        actorDiscordId: actorId,
        targetDiscordId: targetUser.id,
      });
    }
  },
};
