/**
 * Composizione dell'applicazione, lato Worker.
 *
 * Unico punto in cui i service vengono istanziati e collegati fra loro:
 * l'erede diretto di `createContext` della V1, con il gateway REST al posto
 * del client discord.js.
 *
 * Viene eseguito una volta per invocazione. È volutamente economico: nessuna
 * chiamata di rete, nessuna query — solo costruzione di oggetti. Le richieste
 * a Discord partono quando un handler le chiede davvero, il che conta sul
 * piano gratuito.
 */
import { buildChannelRegistry } from '../config/channels.js';
import type { Env } from '../config/env.js';
import { buildRoleRegistry } from '../config/roles.js';
import type { Database } from '../database/prisma.js';
import { createDiscordAuditSink } from '../discord/auditSink.js';
import { createDiscordRestGateway, type DiscordGateway } from '../discord/gateway.js';
import { createDiscordRest } from '../discord/rest.js';
import { createRepositories } from '../repositories/index.js';
import { createAuditService } from '../services/auditService.js';
import { createAuthorizationService } from '../services/authorizationService.js';
import { createBlacklistService } from '../services/blacklistService.js';
import { createCommunityService } from '../services/communityService.js';
import { createConsistencyService } from '../services/consistencyService.js';
import { createMemberLifecycleMessageService } from '../services/memberLifecycleMessageService.js';
import { createMemberReconciliationService } from '../services/memberReconciliationService.js';
import { createMemberService } from '../services/memberService.js';
import { createPanelService } from '../services/panelService.js';
import { createRoleService } from '../services/roleService.js';
import { createStatsService } from '../services/statsService.js';
import { createTtpApplicationService } from '../services/ttpApplicationService.js';
import { createVerificationService } from '../services/verificationService.js';
import { buildApplicationMessage } from '../components/embeds/applicationCard.js';
import type { AppContext } from '../types/context.js';

let isolateStartedAt: Date | undefined;

/**
 * Istante in cui l'isolate ha iniziato a servire richieste.
 *
 * Va calcolato alla PRIMA richiesta, non all'inizializzazione del modulo:
 * durante lo startup di un Worker l'orologio è fermo all'epoch, quindi un
 * `new Date()` a livello di modulo darebbe il 1° gennaio 1970 — e `/ping`
 * mostrerebbe un uptime di vent'anni.
 */
export function getIsolateStartedAt(): Date {
  isolateStartedAt ??= new Date();
  return isolateStartedAt;
}

export interface WorkerContextDeps {
  readonly env: Env;
  readonly db: Database;
  /** Iniettabile nei test: default `globalThis.fetch`. */
  readonly fetchImpl?: typeof fetch | undefined;
}

export interface WorkerContext {
  readonly app: AppContext;
  readonly gateway: DiscordGateway;
}

export function createWorkerContext(deps: WorkerContextDeps): WorkerContext {
  const { env, db } = deps;

  const roles = buildRoleRegistry(env);
  const channels = buildChannelRegistry(env);
  const repos = createRepositories(db);

  const rest = createDiscordRest({
    token: env.discordToken,
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
  });

  const gateway = createDiscordRestGateway({
    rest,
    guildId: env.guildId,
    applicationId: env.clientId,
  });

  const roleService = createRoleService({ roles, gateway });
  const audit = createAuditService({
    audit: repos.audit,
    sink: createDiscordAuditSink({ gateway, channels }),
  });

  const authorization = createAuthorizationService({
    repos,
    roles: roleService,
    gateway,
    guildId: env.guildId,
    ownerId: env.ownerId,
  });

  const verification = createVerificationService({ repos, roles: roleService, gateway, audit });

  const members = createMemberService({
    repos,
    roles: roleService,
    roleRegistry: roles,
    gateway,
    audit,
    guildId: env.guildId,
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
        const messageId = await gateway.sendMessage(
          channels.ttpRequests,
          buildApplicationMessage(application, verificationRecord),
        );
        return { channelId: channels.ttpRequests, messageId };
      },

      async markResolved(application) {
        if (!application.channelId || !application.messageId) return;
        const verificationRecord = await repos.verifications.findByDiscordId(application.discordId);
        await gateway.editMessage(
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
    moderation: gateway,
    guildId: env.guildId,
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
    listGuildMembersWithRoles: (roleIds) => gateway.listMembersWithAnyRole(roleIds),
  });

  const consistency = createConsistencyService({
    repos,
    roles: roleService,
    roleRegistry: roles,
    listAllGuildMembers: () => gateway.listMembers(),
  });

  // Benvenuto e addio: la riconciliazione si limita a dire chi è entrato e chi
  // è uscito, la costruzione del messaggio vive qui dentro.
  const lifecycle = createMemberLifecycleMessageService({
    messages: gateway,
    channels: { welcome: channels.welcome, goodbye: channels.goodbye },
  });

  const reconciliation = createMemberReconciliationService({
    repos,
    roles: roleService,
    roleRegistry: roles,
    audit,
    blacklist,
    lifecycle,
    listAllGuildMembers: () => gateway.listMembers(),
    guildId: env.guildId,
  });

  const stats = createStatsService({ repos });
  const panels = createPanelService({
    panels: repos.panels,
    messages: gateway,
    guildId: env.guildId,
  });

  const app: AppContext = {
    env,
    guildId: env.guildId,
    applicationId: env.clientId,
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
    reconciliation,
    listAllGuildMembers: () => gateway.listMembers(),
    listGuildMembersWithRoles: (roleIds) => gateway.listMembersWithAnyRole(roleIds),
    startedAt: getIsolateStartedAt(),
  };

  return { app, gateway };
}
