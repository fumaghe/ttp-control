/**
 * `/system sync-check` — confronta lo stato Discord con quello a database.
 *
 * SOLO REPORT: nessuna correzione automatica. Le riparazioni automatiche su
 * dati di membership sono più pericolose delle incoerenze che risolvono.
 */
import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { AuditAction } from '../generated/prisma/enums.js';
import { EMBED_COLOR } from '../config/constants.js';
import { brandEmbed, truncate } from '../components/embeds/base.js';
import { handleInteractionError } from '../errors/handleInteractionError.js';
import type { Inconsistency } from '../services/consistencyService.js';
import type { SlashCommand } from '../types/command.js';
import { defer, respond } from '../utils/respond.js';

function groupByKind(issues: readonly Inconsistency[]): Map<string, Inconsistency[]> {
  const grouped = new Map<string, Inconsistency[]>();
  for (const issue of issues) {
    const bucket = grouped.get(issue.kind) ?? [];
    bucket.push(issue);
    grouped.set(issue.kind, bucket);
  }
  return grouped;
}

export const systemCommand: SlashCommand = {
  name: 'system',

  data: new SlashCommandBuilder()
    .setName('system')
    .setDescription('Diagnostica di sistema')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub.setName('sync-check').setDescription('Rileva incoerenze fra ruoli Discord e database'),
    )
    .toJSON(),

  async execute(interaction, ctx): Promise<void> {
    await defer(interaction, { ephemeral: true });

    try {
      const actor = await ctx.authorization.resolveActor(interaction.user.id);
      await ctx.authorization.require(actor, 'system.check');

      const report = await ctx.consistency.run();

      await ctx.audit.record({
        action: AuditAction.SYNC_CHECK_RUN,
        actorDiscordId: interaction.user.id,
        metadata: {
          issues: report.issues.length,
          checkedMembers: report.checkedMembers,
          validMembers: report.validMembers,
        },
      });

      const errors = report.issues.filter((issue) => issue.severity === 'error');
      const warnings = report.issues.filter((issue) => issue.severity === 'warning');

      const embed = brandEmbed('DATA INTEGRITY')
        .setColor(
          errors.length > 0
            ? EMBED_COLOR.danger
            : warnings.length > 0
              ? EMBED_COLOR.warning
              : EMBED_COLOR.success,
        )
        .setDescription(
          [
            `✅ **${report.validMembers}** membri coerenti`,
            errors.length > 0 ? `❌ **${errors.length}** incoerenze critiche` : '',
            warnings.length > 0 ? `⚠️ **${warnings.length}** avvisi` : '',
            report.issues.length === 0 ? '\nNessuna incoerenza rilevata.' : '',
          ]
            .filter(Boolean)
            .join('\n'),
        );

      // Un field per categoria: leggibile e sotto i 25 field di Discord.
      const grouped = groupByKind([...errors, ...warnings]);
      let fieldCount = 0;

      for (const [kind, issues] of grouped) {
        if (fieldCount >= 20) break;
        const first = issues[0];
        if (!first) continue;

        const listed = issues
          .slice(0, 8)
          .map((issue) => `<@${issue.discordId}> — ${issue.detail}`)
          .join('\n');

        embed.addFields({
          name: `${first.severity === 'error' ? '❌' : '⚠️'} ${kind} · ${issues.length}`,
          value: truncate(
            `${listed}${issues.length > 8 ? `\n_…e altri ${issues.length - 8}_` : ''}\n\n➤ ${first.suggestion}`,
          ),
        });
        fieldCount += 1;
      }

      embed.setFooter({
        text: `${report.checkedGuildMembers} membri Discord · ${report.checkedMembers} record a database · nessuna correzione automatica`,
      });

      await respond(interaction, { embeds: [embed] });
    } catch (error) {
      await handleInteractionError(interaction, error, {
        operation: '/system sync-check',
        actorDiscordId: interaction.user.id,
      });
    }
  },
};
