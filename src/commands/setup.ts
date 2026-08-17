/**
 * `/setup` — system check, verify panel, control panel.
 *
 * Diagnostica concreta: non "qualcosa non va", ma esattamente quale ruolo il
 * bot non riesce a gestire e cosa fare per risolverlo.
 */
import {
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type GuildBasedChannel,
} from 'discord.js';
import { AuditAction, PanelType } from '../generated/prisma/enums.js';
import { EMBED_COLOR } from '../config/constants.js';
import { pingDatabase } from '../database/prisma.js';
import { buildVerifyPanel } from '../components/embeds/verifyPanel.js';
import { buildControlPanel } from '../components/embeds/controlPanel.js';
import { brandEmbed, successEmbed, truncate } from '../components/embeds/base.js';
import { handleInteractionError } from '../errors/handleInteractionError.js';
import type { SlashCommand } from '../types/command.js';
import type { AppContext } from '../types/context.js';
import { defer, respond } from '../utils/respond.js';

type CheckStatus = 'ok' | 'warn' | 'fail';

interface CheckResult {
  readonly label: string;
  readonly status: CheckStatus;
  /** Presente solo se non `ok`: spiega il problema e come risolverlo. */
  readonly detail?: string;
}

const ICON: Record<CheckStatus, string> = { ok: '✅', warn: '⚠️', fail: '❌' };

/** Permessi realmente necessari. `Administrator` NON è tra questi. */
const REQUIRED_GUILD_PERMISSIONS = [
  { flag: PermissionFlagsBits.ManageRoles, label: 'Manage Roles' },
  { flag: PermissionFlagsBits.ManageNicknames, label: 'Manage Nicknames' },
] as const;

const REQUIRED_CHANNEL_PERMISSIONS = [
  { flag: PermissionFlagsBits.ViewChannel, label: 'View Channel' },
  { flag: PermissionFlagsBits.SendMessages, label: 'Send Messages' },
  { flag: PermissionFlagsBits.EmbedLinks, label: 'Embed Links' },
  { flag: PermissionFlagsBits.ReadMessageHistory, label: 'Read Message History' },
] as const;

async function runSystemCheck(ctx: AppContext): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const { guild } = ctx;

  // --- Guild ---------------------------------------------------------------
  results.push(
    guild.id === ctx.env.guildId
      ? { label: 'Guild', status: 'ok' }
      : {
          label: 'Guild',
          status: 'fail',
          detail: `GUILD_ID nel .env (${ctx.env.guildId}) non corrisponde a questo server (${guild.id}).`,
        },
  );

  // --- Database ------------------------------------------------------------
  const database = await pingDatabase(ctx.db);
  results.push(
    database.ok
      ? { label: `Database / Neon (${database.latencyMs} ms)`, status: 'ok' }
      : {
          label: 'Database / Neon',
          status: 'fail',
          detail:
            'Il database non risponde. Controlla DATABASE_URL e che il progetto Neon sia attivo.',
        },
  );

  // --- Ruoli ---------------------------------------------------------------
  const me = guild.members.me;
  const missingRoles: string[] = [];
  const unmanageableRoles: string[] = [];

  for (const descriptor of ctx.roles.all) {
    const role = guild.roles.cache.get(descriptor.id);
    if (!role) {
      missingRoles.push(`${descriptor.label} (\`${descriptor.id}\`)`);
      continue;
    }

    const mustManage = ctx.roles.managed.some((m) => m.id === descriptor.id);
    if (mustManage && me && (role.managed || me.roles.highest.comparePositionTo(role) <= 0)) {
      unmanageableRoles.push(descriptor.label);
    }

    results.push({ label: descriptor.label, status: 'ok' });
  }

  if (missingRoles.length > 0) {
    results.push({
      label: 'Ruoli mancanti',
      status: 'fail',
      detail: `Questi ruoli non esistono in questo server:\n${missingRoles.join('\n')}\n\nControlla gli ID nel \`.env\`.`,
    });
  }

  // --- Gerarchia dei ruoli --------------------------------------------------
  if (!me) {
    results.push({
      label: 'Role Hierarchy',
      status: 'fail',
      detail: 'Impossibile leggere il membro bot nella guild.',
    });
  } else if (unmanageableRoles.length > 0) {
    results.push({
      label: 'Role Hierarchy',
      status: 'fail',
      detail: [
        'TTP Control non può gestire:',
        ...unmanageableRoles.map((name) => `• **${name}**`),
        '',
        `Sposta il ruolo **${me.roles.highest.name}** sopra questi ruoli`,
        'in Impostazioni server → Ruoli.',
      ].join('\n'),
    });
  } else {
    results.push({ label: 'Role Hierarchy', status: 'ok' });
  }

  // --- Permessi della guild -------------------------------------------------
  for (const permission of REQUIRED_GUILD_PERMISSIONS) {
    const has = me?.permissions.has(permission.flag) ?? false;
    results.push(
      has
        ? { label: permission.label, status: 'ok' }
        : {
            label: permission.label,
            status: 'fail',
            detail: `Il bot non ha il permesso **${permission.label}**. Aggiungilo al suo ruolo (non serve Administrator).`,
          },
    );
  }

  // --- Canali ---------------------------------------------------------------
  for (const descriptor of ctx.channels.all) {
    const channel: GuildBasedChannel | undefined = guild.channels.cache.get(descriptor.id);

    if (!channel) {
      results.push({
        label: descriptor.label,
        status: 'fail',
        detail: `Canale \`${descriptor.id}\` non trovato in questo server.`,
      });
      continue;
    }

    if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) {
      results.push({
        label: descriptor.label,
        status: 'fail',
        detail: `**${channel.name}** non è un canale testuale.`,
      });
      continue;
    }

    const permissions = me ? channel.permissionsFor(me) : null;
    const missing = REQUIRED_CHANNEL_PERMISSIONS.filter(
      (permission) => !permissions?.has(permission.flag),
    ).map((permission) => permission.label);

    results.push(
      missing.length === 0
        ? { label: descriptor.label, status: 'ok' }
        : {
            label: descriptor.label,
            status: 'fail',
            detail: `In **#${channel.name}** mancano: ${missing.join(', ')}.`,
          },
    );
  }

  // --- Intent privilegiato --------------------------------------------------
  try {
    await guild.members.fetch({ limit: 1 });
    results.push({ label: 'Server Members Intent', status: 'ok' });
  } catch {
    results.push({
      label: 'Server Members Intent',
      status: 'fail',
      detail:
        'Impossibile enumerare i membri. Attiva **Server Members Intent** nel Developer Portal → Bot → Privileged Gateway Intents.',
    });
  }

  return results;
}

function renderReport(results: readonly CheckResult[]) {
  const failures = results.filter((r) => r.status === 'fail');
  const warnings = results.filter((r) => r.status === 'warn');

  const embed = brandEmbed('SYSTEM CHECK')
    .setColor(
      failures.length > 0
        ? EMBED_COLOR.danger
        : warnings.length > 0
          ? EMBED_COLOR.warning
          : EMBED_COLOR.success,
    )
    .setDescription(truncate(results.map((r) => `${ICON[r.status]} ${r.label}`).join('\n'), 4000));

  for (const problem of [...failures, ...warnings].slice(0, 10)) {
    embed.addFields({
      name: `${ICON[problem.status]} ${problem.label}`,
      value: truncate(problem.detail ?? 'Nessun dettaglio disponibile.'),
    });
  }

  embed.setFooter({
    text:
      failures.length === 0
        ? warnings.length === 0
          ? 'SYSTEM READY'
          : `SYSTEM READY — ${warnings.length} avviso/i`
        : `${failures.length} problema/i da risolvere`,
  });

  return { embed, failures: failures.length, warnings: warnings.length };
}

export const setupCommand: SlashCommand = {
  name: 'setup',

  data: new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Configurazione e diagnostica di TTP Control')
    // Nasconde il comando a chi non gestisce il server; l'authorization vera
    // resta comunque quella applicativa, verificata nell'handler.
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub.setName('check').setDescription('Verifica ruoli, canali, permessi e database'),
    )
    .addSubcommand((sub) =>
      sub.setName('verify-panel').setDescription('Pubblica (o aggiorna) il pannello di verifica'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('control-panel')
        .setDescription('Pubblica (o aggiorna) il control panel della Leadership'),
    )
    .toJSON(),

  async execute(interaction, ctx): Promise<void> {
    await defer(interaction, { ephemeral: true });
    const subcommand = interaction.options.getSubcommand(true);

    try {
      const actor = await ctx.authorization.resolveActor(interaction.user.id);
      await ctx.authorization.require(actor, 'setup.run');

      switch (subcommand) {
        case 'check': {
          const results = await runSystemCheck(ctx);
          const report = renderReport(results);

          await ctx.audit.record({
            action: AuditAction.SETUP_RUN,
            actorDiscordId: interaction.user.id,
            metadata: { failures: report.failures, warnings: report.warnings },
          });

          await respond(interaction, { embeds: [report.embed] });
          return;
        }

        case 'verify-panel': {
          const result = await ctx.panels.publish({
            panelType: PanelType.VERIFY,
            channelId: ctx.channels.verify,
            payload: buildVerifyPanel(),
          });

          await ctx.audit.record({
            action: AuditAction.PANEL_PUBLISHED,
            actorDiscordId: interaction.user.id,
            entityType: 'PersistentPanel',
            entityId: result.messageId,
            metadata: { panelType: 'VERIFY', action: result.action },
          });

          await respond(interaction, {
            embeds: [
              successEmbed(
                result.action === 'created' ? 'Pannello pubblicato' : 'Pannello aggiornato',
                `Il pannello di verifica è attivo in <#${ctx.channels.verify}>.\n\nNon verrà duplicato ai prossimi riavvii.`,
              ),
            ],
          });
          return;
        }

        case 'control-panel': {
          const stats = await ctx.stats.dashboard();
          const result = await ctx.panels.publish({
            panelType: PanelType.CONTROL_PANEL,
            channelId: ctx.channels.controlPanel,
            payload: buildControlPanel(stats),
          });

          await ctx.audit.record({
            action: AuditAction.PANEL_PUBLISHED,
            actorDiscordId: interaction.user.id,
            entityType: 'PersistentPanel',
            entityId: result.messageId,
            metadata: { panelType: 'CONTROL_PANEL', action: result.action },
          });

          await respond(interaction, {
            embeds: [
              successEmbed(
                result.action === 'created'
                  ? 'Control panel pubblicato'
                  : 'Control panel aggiornato',
                `Il control panel è attivo in <#${ctx.channels.controlPanel}>.`,
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
        operation: `/setup ${subcommand}`,
        actorDiscordId: interaction.user.id,
      });
    }
  },
};
