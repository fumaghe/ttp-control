import { SlashCommandBuilder } from '@discordjs/builders';
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
 * Non c'è più una latenza "gateway" da mostrare: senza connessione
 * persistente si misura invece un round-trip REST verso Discord, che è
 * l'unico canale che il bot usa davvero.
 *
 * L'uptime è quello dell'ISOLATE del Worker, non del bot: su Cloudflare non
 * esiste un processo che resta acceso, e fingere il contrario darebbe un
 * numero senza significato.
 *
 * Volutamente NON espone host, versioni o connection string: sono
 * informazioni utili solo a chi vuole attaccare il sistema.
 */
export const pingCommand: SlashCommand = {
  name: 'ping',

  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Verifica che TTP Control sia operativo')
    .toJSON(),

  async execute(interaction, ctx): Promise<void> {
    const startedAt = Date.now();
    const [database, discordOk] = await Promise.all([
      pingDatabase(ctx.db),
      ctx.gateway
        .getSelfMember()
        .then(() => true)
        .catch(() => false),
    ]);
    const discordMs = Date.now() - startedAt;

    const embed = neutralEmbed(`${BOT_NAME} · online`)
      .setColor(database.ok && discordOk ? EMBED_COLOR.success : EMBED_COLOR.danger)
      .addFields(
        {
          name: 'Discord API',
          value: discordOk ? `🟢 ${discordMs} ms` : '🔴 non raggiungibile',
          inline: true,
        },
        {
          name: 'Database',
          value: database.ok ? `🟢 ${database.latencyMs} ms` : '🔴 non raggiungibile',
          inline: true,
        },
        { name: 'Isolate', value: formatUptime(ctx.startedAt), inline: true },
      )
      .setFooter({ text: `v${BOT_VERSION} · Cloudflare Workers` });

    await respond(interaction, { embeds: [embed] });
  },
};
