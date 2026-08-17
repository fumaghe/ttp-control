/**
 * Composizione dell'applicazione.
 *
 * Unico punto in cui i service vengono istanziati e collegati fra loro.
 * Tutto il resto riceve `AppContext` già costruito.
 */
import type { BaseMessageOptions, Client, Guild } from 'discord.js';
import { buildChannelRegistry } from '../config/channels.js';
import type { Env } from '../config/env.js';
import { buildRoleRegistry } from '../config/roles.js';
import type { Database } from '../database/prisma.js';
import { createRepositories } from '../repositories/index.js';
import { createAuditService } from '../services/auditService.js';
import { createAuthorizationService } from '../services/authorizationService.js';
import { createBlacklistService } from '../services/blacklistService.js';
import { createCommunityService } from '../services/communityService.js';
import { createConsistencyService } from '../services/consistencyService.js';
import { createMemberService } from '../services/memberService.js';
import { createPanelService, type PanelMessageGateway } from '../services/panelService.js';
import { createRoleService } from '../services/roleService.js';
import { createStatsService } from '../services/statsService.js';
import { createTtpApplicationService } from '../services/ttpApplicationService.js';
import { createVerificationService } from '../services/verificationService.js';
import { buildApplicationMessage } from '../components/embeds/applicationCard.js';
import type { AppContext } from '../types/context.js';
import { createLogger } from '../utils/logger.js';
import { createDiscordAuditSink } from './discordAuditSink.js';
import {
  createDiscordModerationGateway,
  createDiscordRoleGateway,
  createMemberEnumerator,
} from './discordRoleGateway.js';

const log = createLogger('context');

function createPanelMessageGateway(client: Client<true>): PanelMessageGateway {
  return {
    async edit(channelId, messageId, payload): Promise<boolean> {
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel?.isTextBased()) return false;
      const message = await channel.messages.fetch(messageId).catch(() => null);
      if (!message) return false;
      await message.edit(payload);
      return true;
    },

    async send(channelId, payload): Promise<string> {
      const channel = await client.channels.fetch(channelId);
      if (!channel?.isSendable()) {
        throw new Error(`Il canale ${channelId} non è scrivibile dal bot`);
      }
      const message = await channel.send(payload);
      return message.id;
    },
  };
}

export function createContext(deps: {
  client: Client<true>;
  guild: Guild;
  env: Env;
  db: Database;
  startedAt: Date;
}): AppContext {
  const { client, guild, env, db, startedAt } = deps;

  const roles = buildRoleRegistry(env);
  const channels = buildChannelRegistry(env);
  const repos = createRepositories(db);

  const gateway = createDiscordRoleGateway({ guild });
  const moderation = createDiscordModerationGateway(guild);
  const enumerator = createMemberEnumerator(guild);
  const messages = createPanelMessageGateway(client);

  const roleService = createRoleService({ roles, gateway });
  const audit = createAuditService({
    audit: repos.audit,
    sink: createDiscordAuditSink({ client, channels }),
  });

  const authorization = createAuthorizationService({
    repos,
    roles: roleService,
    gateway,
    guildId: guild.id,
    ownerId: env.ownerId,
  });

  const verification = createVerificationService({ repos, roles: roleService, gateway, audit });

  const members = createMemberService({
    repos,
    roles: roleService,
    roleRegistry: roles,
    gateway,
    audit,
    guildId: guild.id,
  });

  const applications = createTtpApplicationService({
    repos,
    members,
    roles: roleService,
    gateway,
    audit,
    publisher: {
      async publish(application) {
        const verificationRecord = await repos.verifications.findByDiscordId(application.discordId);
        const payload: BaseMessageOptions = buildApplicationMessage(
          application,
          verificationRecord,
        );
        const messageId = await messages.send(channels.ttpRequests, payload);
        return { channelId: channels.ttpRequests, messageId };
      },

      async markResolved(application) {
        if (!application.channelId || !application.messageId) return;
        const verificationRecord = await repos.verifications.findByDiscordId(application.discordId);
        await messages.edit(
          application.channelId,
          application.messageId,
          buildApplicationMessage(application, verificationRecord),
        );
      },
    },
  });

  const blacklist = createBlacklistService({
    repos,
    roles: roleService,
    gateway,
    audit,
    moderation,
    guildId: guild.id,
  });

  const community = createCommunityService({
    repos,
    roles: roleService,
    gateway,
    audit,
    verification,
    members,
    verifiedRoleId: roles.verified,
    friendRoleId: roles.friend,
    mafiaRoleId: roles.mafia,
    listGuildMembersWithRoles: (roleIds) => enumerator.withAnyRole(roleIds),
  });

  const consistency = createConsistencyService({
    repos,
    roles: roleService,
    roleRegistry: roles,
    listAllGuildMembers: () => enumerator.all(),
  });

  const stats = createStatsService({ repos });
  const panels = createPanelService({ panels: repos.panels, messages, guildId: guild.id });

  log.info(
    { guild: guild.name, roles: roles.all.length, channels: channels.all.length },
    'Contesto applicativo pronto',
  );

  return {
    client,
    guild,
    env,
    db,
    repos,
    roles,
    channels,
    gateway,
    roleService,
    audit,
    authorization,
    verification,
    applications,
    members,
    community,
    blacklist,
    consistency,
    stats,
    panels,
    listAllGuildMembers: () => enumerator.all(),
    listGuildMembersWithRoles: (roleIds) => enumerator.withAnyRole(roleIds),
    startedAt,
  };
}
