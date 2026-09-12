import { SlashCommandBuilder } from '@discordjs/builders';
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
    // NESSUN `setDefaultMemberPermissions`: l'autorizzazione di questo comando e'
    // APPLICATIVA, non Discord.
    //
    // Un gate `ManageRoles`/`ManageGuild` qui sopra si frappone PRIMA della
    // permission matrix e rende inutile assegnare OG o Big Homie: Discord
    // rifiuterebbe l'interaction prima ancora che il bot la veda. Il comando
    // resta quindi VISIBILE a tutti, ed e' l'handler a rifiutare server-side —
    // cosa che fa a ogni singola interaction, bottoni e modal compresi, perche'
    // chi ha aperto un pannello non dice nulla su chi ci sta cliccando adesso.
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
