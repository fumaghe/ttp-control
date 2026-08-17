/**
 * Costruttori di embed condivisi.
 *
 * Tenere qui la presentazione evita che ogni handler reinventi colori,
 * intestazioni e formattazione delle date.
 */
import { EmbedBuilder } from '@discordjs/builders';
import { DISCORD_LIMITS, EMBED_COLOR, GANG_NAME } from '../../config/constants.js';

/** Data in formato italiano: `17/08/2026`. */
export function formatDate(date: Date | null | undefined): string {
  if (!date) return '—';
  return new Intl.DateTimeFormat('it-IT', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'Europe/Rome',
  }).format(date);
}

/** Timestamp relativo nativo di Discord: si aggiorna da solo. */
export function relativeTime(date: Date | null | undefined): string {
  if (!date) return '—';
  return `<t:${Math.floor(date.getTime() / 1000)}:R>`;
}

/** Menzione di un utente a partire dall'ID. */
export function mention(discordId: string | null | undefined): string {
  return discordId ? `<@${discordId}>` : '—';
}

/** Tronca al limite di un field, senza tagliare a metà una riga se evitabile. */
export function truncate(text: string, max: number = DISCORD_LIMITS.embedFieldValue): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const lastNewline = cut.lastIndexOf('\n');
  const body = lastNewline > max * 0.6 ? cut.slice(0, lastNewline) : cut;
  return `${body}…`;
}

/** Neutralizza la formattazione markdown nei testi inseriti dagli utenti. */
export function escapeMarkdown(text: string): string {
  return text.replace(/([*_~`|\\>])/g, '\\$1');
}

function base(color: number): EmbedBuilder {
  return new EmbedBuilder().setColor(color).setTimestamp(new Date());
}

export function brandEmbed(title: string): EmbedBuilder {
  return base(EMBED_COLOR.brand).setAuthor({ name: GANG_NAME }).setTitle(title);
}

export function successEmbed(title: string, description?: string): EmbedBuilder {
  const embed = base(EMBED_COLOR.success).setTitle(`✅ ${title}`);
  return description ? embed.setDescription(description) : embed;
}

export function warningEmbed(title: string, description?: string): EmbedBuilder {
  const embed = base(EMBED_COLOR.warning).setTitle(`⚠️ ${title}`);
  return description ? embed.setDescription(description) : embed;
}

export function errorEmbed(title: string, description?: string): EmbedBuilder {
  const embed = base(EMBED_COLOR.danger).setTitle(`❌ ${title}`);
  return description ? embed.setDescription(description) : embed;
}

export function infoEmbed(title: string, description?: string): EmbedBuilder {
  const embed = base(EMBED_COLOR.info).setTitle(title);
  return description ? embed.setDescription(description) : embed;
}

export function neutralEmbed(title: string): EmbedBuilder {
  return base(EMBED_COLOR.neutral).setTitle(title);
}
