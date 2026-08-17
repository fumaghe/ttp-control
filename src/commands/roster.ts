import { SlashCommandBuilder } from 'discord.js';
import { MemberStatus, type MemberRank } from '../generated/prisma/enums.js';
import { RANK_LABEL, RANK_ORDER } from '../config/constants.js';
import { STATUS_LABEL } from '../components/embeds/memberCard.js';
import {
  buildRosterControls,
  buildRosterPages,
  encodeFilterToken,
} from '../components/embeds/roster.js';
import { handleInteractionError } from '../errors/handleInteractionError.js';
import type { SlashCommand } from '../types/command.js';
import type { AppContext } from '../types/context.js';
import type { Member } from '../repositories/types.js';
import { defer, respond } from '../utils/respond.js';

/** Stati che compongono il roster: chi è uscito o è morto non compare. */
const ROSTER_STATUSES: readonly MemberStatus[] = [MemberStatus.ACTIVE, MemberStatus.INACTIVE];

export interface RosterQuery {
  readonly rank: MemberRank | null;
  readonly status: MemberStatus | null;
  readonly roleId: string | null;
}

/**
 * Recupera il roster applicando i filtri.
 *
 * Il filtro per ruolo Discord si applica dopo la query: è l'unico dato che
 * vive solo su Discord e non a database.
 */
export async function fetchRoster(ctx: AppContext, query: RosterQuery): Promise<Member[]> {
  const members = await ctx.members.roster({
    rank: query.rank ?? undefined,
    ...(query.status === null ? { statusIn: ROSTER_STATUSES } : { status: query.status }),
  });

  if (!query.roleId) return members;

  const holders = await ctx.listGuildMembersWithRoles([query.roleId]);
  const holderIds = new Set(holders.map((snapshot) => snapshot.discordId));
  return members.filter((member) => holderIds.has(member.discordId));
}

export const rosterCommand: SlashCommand = {
  name: 'roster',

  data: new SlashCommandBuilder()
    .setName('roster')
    .setDescription('Elenco dei membri della gang, raggruppati per rank')
    .addStringOption((o) =>
      o
        .setName('rank')
        .setDescription('Filtra per rank')
        .addChoices(...RANK_ORDER.map((rank) => ({ name: RANK_LABEL[rank], value: rank }))),
    )
    .addStringOption((o) =>
      o
        .setName('status')
        .setDescription('Filtra per stato')
        .addChoices(
          { name: STATUS_LABEL.ACTIVE, value: MemberStatus.ACTIVE },
          { name: STATUS_LABEL.INACTIVE, value: MemberStatus.INACTIVE },
        ),
    )
    .addRoleOption((o) =>
      o.setName('role').setDescription('Filtra per ruolo Discord (es. Shooter)'),
    )
    .toJSON(),

  async execute(interaction, ctx): Promise<void> {
    await defer(interaction, { ephemeral: true });

    try {
      const actor = await ctx.authorization.resolveActor(interaction.user.id);
      await ctx.authorization.require(actor, 'roster.view');

      const rank = interaction.options.getString('rank') as MemberRank | null;
      const status = interaction.options.getString('status') as MemberStatus | null;
      const role = interaction.options.getRole('role');

      const members = await fetchRoster(ctx, { rank, status, roleId: role?.id ?? null });

      const pages = buildRosterPages(members, {
        rank: rank ? RANK_LABEL[rank] : undefined,
        status: status ? STATUS_LABEL[status] : undefined,
        roleMention: role ? `<@&${role.id}>` : undefined,
      });

      const first = pages[0];
      if (!first) {
        await respond(interaction, { content: 'Nessun risultato.' });
        return;
      }

      await respond(interaction, {
        embeds: [first.embed],
        // Il filtro per ruolo non entra nel token di paginazione: resterebbe
        // nel customId senza aggiungere nulla, dato che il roster viene
        // ricalcolato a ogni click.
        components: buildRosterControls(0, first.totalPages, encodeFilterToken(rank, status)),
      });
    } catch (error) {
      await handleInteractionError(interaction, error, {
        operation: '/roster',
        actorDiscordId: interaction.user.id,
      });
    }
  },
};
