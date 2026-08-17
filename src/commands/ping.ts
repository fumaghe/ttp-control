import { SlashCommandBuilder } from 'discord.js';
import { pingDatabase } from '../database/prisma.js';
import { BOT_NAME, BOT_VERSION, EMBED_COLOR } from '../config/constants.js';
import { neutralEmbed } from '../components/embeds/base.js';
import { respond } from '../utils/respond.js';
import type { SlashCommand } from '../types/command.js';

function formatUptime(since: Date): string {
  const seconds = Math.floor((Date.now() - since.getTime()) / 1000);
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}g`);
  if (hours > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(' ');
}

/**
 * Health check operativo.
 *
 * Mostra latenza gateway, stato del database e uptime. Volutamente NON
 * espone host, versioni o connection string: sono informazioni utili solo a
 * chi vuole attaccare il sistema.
 */
export const pingCommand: SlashCommand = {
  name: 'ping',

  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Verifica che TTP Control sia operativo')
    .toJSON(),

  async execute(interaction, ctx): Promise<void> {
    const database = await pingDatabase(ctx.db);
    const gatewayMs = Math.max(ctx.client.ws.ping, 0);

    const embed = neutralEmbed(`${BOT_NAME} · online`)
      .setColor(database.ok ? EMBED_COLOR.success : EMBED_COLOR.danger)
      .addFields(
        { name: 'Gateway', value: `${gatewayMs} ms`, inline: true },
        {
          name: 'Database',
          value: database.ok ? `🟢 ${database.latencyMs} ms` : '🔴 non raggiungibile',
          inline: true,
        },
        { name: 'Uptime', value: formatUptime(ctx.startedAt), inline: true },
      )
      .setFooter({ text: `v${BOT_VERSION}` });

    await respond(interaction, { embeds: [embed] });
  },
};
