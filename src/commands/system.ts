/**
 * `/system sync-check` — confronta lo stato Discord con quello a database.
 *
 * SOLO REPORT, anche con `ROLE_SYNC_MODE=IMPORT_SAFE`: eseguire una diagnostica
 * non deve cambiare lo stato che si sta guardando. Se una voce è importabile
 * sarà il cron ad applicarla, non questo comando.
 *
 * Le voci sono separate in due gruppi, che è la distinzione che conta davvero
 * per chi legge: quelle che si sistemano da sole al prossimo cron e quelle che
 * richiedono una decisione umana — una motivazione, un autore, la volontà di
 * far uscire davvero qualcuno dalla gang. Sono cose che un ruolo Discord non
 * porta con sé, e nessuna automazione può inventarle.
 */
import { SlashCommandBuilder } from '@discordjs/builders';
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
    // NESSUN `setDefaultMemberPermissions`: l'autorizzazione di questo comando e'
    // APPLICATIVA, non Discord.
    //
    // Un gate `ManageRoles`/`ManageGuild` qui sopra si frappone PRIMA della
    // permission matrix e rende inutile assegnare OG o Big Homie: Discord
    // rifiuterebbe l'interaction prima ancora che il bot la veda. Il comando
    // resta quindi VISIBILE a tutti, ed e' l'handler a rifiutare server-side —
    // cosa che fa a ogni singola interaction, bottoni e modal compresi, perche'
    // chi ha aperto un pannello non dice nulla su chi ci sta cliccando adesso.
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
          mode: report.mode,
          importableIssues: report.importableIssues,
        },
      });

      const errors = report.issues.filter((issue) => issue.severity === 'error');
      const warnings = report.issues.filter((issue) => issue.severity === 'warning');
      const importable = report.issues.filter((issue) => issue.importable);
      const manual = report.issues.filter((issue) => !issue.importable);
      const autoImport = report.mode === 'IMPORT_SAFE';

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
            '',
            `⚙️ \`ROLE_SYNC_MODE\` = **${report.mode}**`,
            importable.length > 0
              ? autoImport
                ? `📥 **${importable.length}** verranno importate dal prossimo cron (max 5 minuti): nessun intervento necessario.`
                : `📥 **${importable.length}** sarebbero importabili automaticamente, ma la modalità è REPORT_ONLY: vanno applicate a mano.`
              : '',
            manual.length > 0
              ? `🔒 **${manual.length}** richiedono una decisione umana: non verranno mai importate da sole.`
              : '',
          ]
            .filter(Boolean)
            .join('\n'),
        );

      // Un field per categoria, con PRIMA quelle che richiedono una persona:
      // sono le uniche su cui chi legge deve fare qualcosa adesso.
      const grouped = groupByKind([...manual, ...importable]);
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
          name: `${first.severity === 'error' ? '❌' : '⚠️'} ${kind} · ${issues.length}${
            first.importable ? (autoImport ? ' · 📥 auto' : ' · 📥 importabile') : ' · 🔒 manuale'
          }`,
          value: truncate(
            `${listed}${issues.length > 8 ? `\n_…e altri ${issues.length - 8}_` : ''}\n\n➤ ${first.suggestion}`,
          ),
        });
        fieldCount += 1;
      }

      embed.setFooter({
        text: `${report.checkedGuildMembers} membri Discord · ${report.checkedMembers} record a database · questo comando non corregge nulla`,
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
