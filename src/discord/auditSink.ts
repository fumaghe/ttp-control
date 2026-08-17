/**
 * Consegna dei log di audit sui canali Discord, via REST.
 *
 * Ogni metodo puo' fallire senza conseguenze: `auditService` cattura gli
 * errori e li registra, perche' un log non consegnato non deve invalidare
 * un'operazione gia' completata.
 */
import { EmbedBuilder } from '@discordjs/builders';
import { AuditAction } from '../generated/prisma/enums.js';
import type { ChannelRegistry } from '../config/channels.js';
import { EMBED_COLOR } from '../config/constants.js';
import type { AuditEntry, AuditSink } from '../services/auditService.js';
import { escapeMarkdown, mention, truncate } from '../components/embeds/base.js';
import type { DiscordGateway } from './gateway.js';

/** Etichetta leggibile per ciascuna azione. */
const ACTION_LABEL: Record<AuditAction, string> = {
  [AuditAction.USER_VERIFIED]: '✅ Verifica completata',
  [AuditAction.VERIFICATION_REVOKED]: '🚫 Verifica revocata',
  [AuditAction.TTP_APPLICATION_CREATED]: '📨 Candidatura TTP creata',
  [AuditAction.TTP_APPLICATION_APPROVED]: '🩸 Candidatura TTP approvata',
  [AuditAction.TTP_APPLICATION_REJECTED]: '❌ Candidatura TTP rifiutata',
  [AuditAction.TTP_APPLICATION_CANCELLED]: '🗑 Candidatura TTP annullata',
  [AuditAction.TTP_ADDED]: '🩸 Ingresso nella gang',
  [AuditAction.TTP_REMOVED]: '🚪 Uscita dalla gang',
  [AuditAction.PROMOTED]: '⬆ Promozione',
  [AuditAction.DEMOTED]: '⬇ Retrocessione',
  [AuditAction.RANK_CHANGED]: '🎖 Cambio rank',
  [AuditAction.SPECIAL_ROLE_ADDED]: '🎭 Ruolo speciale assegnato',
  [AuditAction.SPECIAL_ROLE_REMOVED]: '🎭 Ruolo speciale rimosso',
  [AuditAction.SET_INACTIVE]: '💤 Impostato inattivo',
  [AuditAction.SET_ACTIVE]: '🟢 Riattivato',
  [AuditAction.MEMBER_NOTES_UPDATED]: '📝 Note aggiornate',
  [AuditAction.COMMUNITY_ROLE_GRANTED]: '🤝 Ruolo community assegnato',
  [AuditAction.COMMUNITY_ROLE_REVOKED]: '🤝 Ruolo community revocato',
  [AuditAction.BLACKLISTED]: '🚫 Blacklist',
  [AuditAction.UNBLACKLISTED]: '♻️ Rimosso dalla blacklist',
  [AuditAction.PERMADEATH]: '💀 Permadeath',
  [AuditAction.KICKED]: '👢 Espulso dal server',
  [AuditAction.BANNED]: '⛔ Bannato dal server',
  [AuditAction.ROLE_SYNC_WARNING]: '⚠️ Divergenza ruoli',
  [AuditAction.MEMBER_JOINED_DISCORD]: '➡️ Entrato nel Discord',
  [AuditAction.MEMBER_LEFT_DISCORD]: '⬅️ Uscito dal Discord',
  [AuditAction.BLACKLISTED_USER_REJOINED]: '🚨 Utente in blacklist rilevato',
  [AuditAction.SETUP_RUN]: '🔧 System check eseguito',
  [AuditAction.SYNC_CHECK_RUN]: '🔍 Controllo integrità eseguito',
  [AuditAction.PANEL_PUBLISHED]: '📌 Pannello pubblicato',
};

/** Azioni che meritano il colore di allarme nel canale di audit. */
const ALARMING: ReadonlySet<AuditAction> = new Set([
  AuditAction.BLACKLISTED,
  AuditAction.PERMADEATH,
  AuditAction.BANNED,
  AuditAction.KICKED,
  AuditAction.ROLE_SYNC_WARNING,
  AuditAction.BLACKLISTED_USER_REJOINED,
]);

export function buildAuditEmbed(entry: AuditEntry): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(ACTION_LABEL[entry.action])
    .setColor(ALARMING.has(entry.action) ? EMBED_COLOR.danger : EMBED_COLOR.neutral)
    .setTimestamp(new Date());

  if (entry.targetDiscordId) {
    embed.addFields({ name: 'Utente', value: mention(entry.targetDiscordId), inline: true });
  }
  if (entry.actorDiscordId) {
    embed.addFields({ name: 'Operatore', value: mention(entry.actorDiscordId), inline: true });
  }
  if (entry.previousValue || entry.newValue) {
    embed.addFields({
      name: 'Cambiamento',
      value: `\`${entry.previousValue ?? '—'}\` → \`${entry.newValue ?? '—'}\``,
      inline: true,
    });
  }
  if (entry.reason) {
    embed.addFields({
      name: 'Motivazione',
      value: truncate(escapeMarkdown(entry.reason)),
      inline: false,
    });
  }
  if (entry.targetDiscordId) {
    embed.setFooter({ text: `ID: ${entry.targetDiscordId}` });
  }

  return embed;
}

export function createDiscordAuditSink(deps: {
  gateway: DiscordGateway;
  channels: ChannelRegistry;
}): AuditSink {
  const { gateway, channels } = deps;

  async function send(channelId: string, entry: AuditEntry): Promise<void> {
    await gateway.sendMessage(channelId, { embeds: [buildAuditEmbed(entry)] });
  }

  return {
    sendAudit: (entry) => send(channels.auditLog, entry),
    sendMemberLog: (entry) => send(channels.memberLogs, entry),
    sendBlacklistLog: (entry) => send(channels.blacklist, entry),
  };
}
