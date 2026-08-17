/**
 * Eventi di membership Discord.
 *
 * Principio guida: il bot OSSERVA e SEGNALA, non corregge da solo.
 * In particolare uscire dal Discord NON è la stessa cosa che lasciare la
 * gang, e una modifica manuale dei ruoli non fa scattare nessuna
 * sincronizzazione distruttiva.
 */
import type { GuildMember, PartialGuildMember } from 'discord.js';
import { AuditAction, MemberStatus } from '../generated/prisma/enums.js';
import { RANK_LABEL } from '../config/constants.js';
import { toSnapshot } from '../client/discordRoleGateway.js';
import type { AppContext } from '../types/context.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('guild-events');

/**
 * Nuovo arrivo (o rientro).
 *
 * Registra l'anagrafica e applica la policy di blacklist. Nessun ruolo viene
 * assegnato: la verifica è un atto volontario dell'utente.
 */
export async function onGuildMemberAdd(member: GuildMember, ctx: AppContext): Promise<void> {
  if (member.guild.id !== ctx.guild.id) return;

  try {
    await ctx.repos.profiles.upsert({
      discordId: member.id,
      username: member.user.username,
      displayName: member.displayName,
    });

    await ctx.audit.record({
      action: AuditAction.MEMBER_JOINED_DISCORD,
      targetDiscordId: member.id,
      metadata: { username: member.user.username },
    });

    // La blacklist è autorevole a database: uscire e rientrare non la aggira.
    const entry = await ctx.blacklist.handleRejoin(member.id, member.user.username);
    if (entry) {
      log.warn({ discordId: member.id }, 'Utente in blacklist rientrato nel server');
    }
  } catch (error) {
    log.error({ err: error, discordId: member.id }, 'guildMemberAdd fallito');
  }
}

/**
 * Uscita dal Discord.
 *
 * NON equivale a `LEFT_TTP`: sono due cose diverse. Se chi esce era un
 * membro, si avvisa la Leadership e si lascia a loro la decisione, senza
 * modificare lo storico di membership come farebbe `/member remove`.
 */
export async function onGuildMemberRemove(
  member: GuildMember | PartialGuildMember,
  ctx: AppContext,
): Promise<void> {
  if (member.guild.id !== ctx.guild.id) return;

  try {
    const dbMember = await ctx.repos.members.findByDiscordId(member.id);
    const wasInGang =
      dbMember !== null &&
      (dbMember.status === MemberStatus.ACTIVE || dbMember.status === MemberStatus.INACTIVE);

    await ctx.audit.record(
      {
        action: AuditAction.MEMBER_LEFT_DISCORD,
        targetDiscordId: member.id,
        metadata: {
          wasTtpMember: wasInGang,
          rank: dbMember?.rank ?? null,
          // Esplicito: nessuna modifica automatica alla membership.
          membershipUnchanged: true,
        },
        reason: wasInGang
          ? 'Un membro TTP ha lasciato il Discord: la membership NON è stata modificata automaticamente'
          : null,
      },
      wasInGang ? ['audit', 'member'] : ['audit'],
    );

    if (wasInGang) {
      // Segnalazione esplicita: serve una decisione umana.
      await ctx.audit.record(
        {
          action: AuditAction.ROLE_SYNC_WARNING,
          targetDiscordId: member.id,
          entityType: 'Member',
          entityId: dbMember.id,
          reason: `Il membro ${RANK_LABEL[dbMember.rank]} ha lasciato il Discord. Usa \`/member remove\` se ha davvero lasciato la gang.`,
        },
        ['member'],
      );
    }
  } catch (error) {
    log.error({ err: error, discordId: member.id }, 'guildMemberRemove fallito');
  }
}

/**
 * Modifica dei ruoli.
 *
 * Se qualcuno tocca a mano un ruolo gestito dal bot, la divergenza viene
 * registrata come warning. Nessuna correzione automatica: sarebbe una
 * sincronizzazione distruttiva su dati che solo un umano può interpretare.
 */
export async function onGuildMemberUpdate(
  oldMember: GuildMember | PartialGuildMember,
  newMember: GuildMember,
  ctx: AppContext,
): Promise<void> {
  if (newMember.guild.id !== ctx.guild.id) return;

  try {
    const before = new Set(oldMember.roles.cache.keys());
    const after = new Set(newMember.roles.cache.keys());

    const added = [...after].filter((id) => !before.has(id));
    const removed = [...before].filter((id) => !after.has(id));
    if (added.length === 0 && removed.length === 0) return;

    // Solo i ruoli che il bot gestisce sono interessanti.
    const managedIds = new Set(ctx.roles.managed.map((descriptor) => descriptor.id));
    const relevantAdded = added.filter((id) => managedIds.has(id));
    const relevantRemoved = removed.filter((id) => managedIds.has(id));
    if (relevantAdded.length === 0 && relevantRemoved.length === 0) return;

    const snapshot = toSnapshot(newMember);
    const dbMember = await ctx.repos.members.findByDiscordId(newMember.id);
    const verification = await ctx.repos.verifications.findActive(newMember.id);

    const divergences: string[] = [];

    const isTtp = ctx.roleService.isTtp(snapshot);
    const inGang =
      dbMember !== null &&
      (dbMember.status === MemberStatus.ACTIVE || dbMember.status === MemberStatus.INACTIVE);

    if (isTtp !== inGang) {
      divergences.push(
        isTtp
          ? 'Ha il ruolo TTP ma a database non risulta membro attivo.'
          : 'Risulta membro a database ma non ha più il ruolo TTP.',
      );
    }

    const ranks = ctx.roleService.readAllRanks(snapshot);
    if (ranks.length > 1) {
      divergences.push(`Ha ${ranks.length} rank contemporaneamente.`);
    }
    const soleRank = ranks.length === 1 ? ranks[0] : undefined;
    if (dbMember && inGang && soleRank !== undefined && soleRank !== dbMember.rank) {
      divergences.push(
        `Rank Discord (${RANK_LABEL[soleRank]}) diverso dal database (${RANK_LABEL[dbMember.rank]}).`,
      );
    }

    const isVerified = ctx.roleService.isVerified(snapshot);
    if (isTtp && !isVerified) {
      divergences.push('Ha il ruolo TTP ma non Verified: viola `TTP ⇒ Verified`.');
    }
    if (isVerified !== (verification !== null)) {
      divergences.push(
        isVerified
          ? 'Ha il ruolo Verified ma nessuna verifica attiva a database.'
          : 'Ha una verifica attiva a database ma non il ruolo Verified.',
      );
    }

    if (divergences.length === 0) return;

    const nameOf = (id: string): string =>
      ctx.roles.all.find((descriptor) => descriptor.id === id)?.label ?? id;

    await ctx.audit.record(
      {
        action: AuditAction.ROLE_SYNC_WARNING,
        targetDiscordId: newMember.id,
        reason: divergences.join('\n'),
        metadata: {
          added: relevantAdded.map(nameOf),
          removed: relevantRemoved.map(nameOf),
          // Il bot non tocca nulla: la correzione è una decisione umana.
          autoCorrected: false,
        },
      },
      ['audit'],
    );

    log.warn(
      { discordId: newMember.id, divergences },
      'Divergenza rilevata dopo una modifica manuale dei ruoli',
    );
  } catch (error) {
    log.error({ err: error, discordId: newMember.id }, 'guildMemberUpdate fallito');
  }
}
