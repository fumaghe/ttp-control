import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { buildControlPanel } from '../components/embeds/controlPanel.js';
import { handleInteractionError } from '../errors/handleInteractionError.js';
import type { SlashCommand } from '../types/command.js';
import { defer, respond } from '../utils/respond.js';

/**
 * `/panel` — control panel effimero per la Leadership.
 *
 * Il pannello persistente nel canale dedicato si pubblica invece con
 * `/setup control-panel`.
 */
export const panelCommand: SlashCommand = {
  name: 'panel',

  data: new SlashCommandBuilder()
    .setName('panel')
    .setDescription('Control panel della Leadership')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .toJSON(),

  async execute(interaction, ctx): Promise<void> {
    await defer(interaction, { ephemeral: true });

    try {
      const actor = await ctx.authorization.resolveActor(interaction.user.id);
      await ctx.authorization.require(actor, 'panel.use');

      const stats = await ctx.stats.dashboard();
      const panel = buildControlPanel(stats);

      await respond(interaction, {
        embeds: panel.embeds ?? [],
        components: panel.components ?? [],
      });
    } catch (error) {
      await handleInteractionError(interaction, error, {
        operation: '/panel',
        actorDiscordId: interaction.user.id,
      });
    }
  },
};
