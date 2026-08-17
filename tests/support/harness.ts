/**
 * Ambiente di test: gateway Discord finto + service reali.
 *
 * I service sotto test sono ESATTAMENTE quelli di produzione: cambia solo il
 * gateway, che qui manipola un insieme di ruoli in memoria invece di chiamare
 * l'API Discord.
 */
import type { Env } from '../../src/config/env.js';
import { buildRoleRegistry, type RoleRegistry } from '../../src/config/roles.js';
import { createAuditService, type AuditService } from '../../src/services/auditService.js';
import { createAuthorizationService } from '../../src/services/authorizationService.js';
import { createBlacklistService } from '../../src/services/blacklistService.js';
import { createCommunityService } from '../../src/services/communityService.js';
import { createConsistencyService } from '../../src/services/consistencyService.js';
import { createMemberService } from '../../src/services/memberService.js';
import {
  createRankAnnouncementService,
  type RankAnnouncementGateway,
} from '../../src/services/rankAnnouncementService.js';
import { createRoleService } from '../../src/services/roleService.js';
import type { MessagePayload } from '../../src/discord/payload.js';
import { createTtpApplicationService } from '../../src/services/ttpApplicationService.js';
import {
  createVerificationService,
  type RawVerificationForm,
} from '../../src/services/verificationService.js';
import type { GuildMemberSnapshot, RoleGateway } from '../../src/services/roleGateway.js';
import type { Repositories } from '../../src/repositories/types.js';
import {
  createInMemoryRepositories,
  createStore,
  type InMemoryStore,
} from './inMemoryRepositories.js';

export const GUILD_ID = '100000000000000001';
export const OWNER_ID = '100000000000000002';

/** Snowflake deterministici, così i test restano leggibili. */
export const ROLE_IDS = {
  verified: '200000000000000001',
  ttp: '200000000000000002',

  // Gerarchia, dal piu' alto al piu' basso.
  og: '200000000000000003',
  bigHomie: '200000000000000004',
  big: '200000000000000019',
  originalTinyLoc: '200000000000000005',
  loc: '200000000000000020',
  tinyLoc: '200000000000000006',
  infantilLoc: '200000000000000021',
  gangBanger: '200000000000000022',
  resident: '200000000000000007',

  friend: '200000000000000008',
  mafia: '200000000000000009',
  banned: '200000000000000010',
  inactive: '200000000000000011',
  permadeath: '200000000000000012',
  honor1: '200000000000000013',
  honor2: '200000000000000014',
  supporter: '200000000000000015',
  firstDay: '200000000000000016',
  shooter: '200000000000000017',
  mainShooter: '200000000000000018',
} as const;

export const CHANNEL_IDS = {
  verify: '300000000000000001',
  verifyRequests: '300000000000000002',
  memberManagement: '300000000000000003',
  memberLogs: '300000000000000004',
  auditLog: '300000000000000005',
  blacklist: '300000000000000006',
  controlPanel: '300000000000000007',
  welcome: '300000000000000008',
  goodbye: '300000000000000009',
  putOnOff: '300000000000000010',
} as const;

export function testEnv(): Env {
  return {
    nodeEnv: 'test',
    logLevel: 'error',
    discordToken: 'test.token.value',
    // Chiave Ed25519 fittizia: 64 caratteri esadecimali, la forma che la
    // validazione dell'environment pretende.
    discordPublicKey: 'a'.repeat(64),
    clientId: '100000000000000003',
    guildId: GUILD_ID,
    ownerId: OWNER_ID,
    databaseUrl: 'postgresql://user:pass@localhost:5432/test',
    directUrl: undefined,
    roles: ROLE_IDS,
    channels: CHANNEL_IDS,
  };
}

/** Membro fittizio della guild. */
export interface FakeMember {
  discordId: string;
  username: string;
  displayName: string;
  roles: Set<string>;
  highestRolePosition: number;
  isGuildOwner: boolean;
  /** Se `false`, il gateway si comporta come se avesse lasciato il server. */
  present: boolean;
  /** Gli account bot non ricevono messaggi di benvenuto/addio. */
  bot: boolean;
  /** Hash dell'avatar: `null` = l'utente usa quello di default. */
  avatar: string | null;
}

/** Messaggio pubblicato su un canale dal bot. */
export interface SentMessage {
  channelId: string;
  payload: MessagePayload;
}

export interface FakeGuild {
  members: Map<string, FakeMember>;
  /** Ruoli che il bot NON può gestire: simula un problema di gerarchia. */
  unmanageableRoles: Set<string>;
  /** DM ricevuti, per verificare le notifiche. */
  notifications: { discordId: string; title: string }[];
  /** Messaggi pubblicati sui canali: usati per verificare Put On / Put Off. */
  messages: SentMessage[];
  /** Se `true`, ogni `sendMessage` fallisce: simula un canale irraggiungibile. */
  failMessages: boolean;
}

export function createFakeGuild(): FakeGuild {
  return {
    members: new Map(),
    unmanageableRoles: new Set(),
    notifications: [],
    messages: [],
    failMessages: false,
  };
}

/** Gateway dei messaggi: registra ciò che il bot pubblica, senza rete. */
export function createFakeMessageGateway(guild: FakeGuild): RankAnnouncementGateway {
  return {
    async sendMessage(channelId: string, payload: MessagePayload): Promise<string> {
      if (guild.failMessages) {
        throw new Error('Canale non raggiungibile (simulato)');
      }
      guild.messages.push({ channelId, payload });
      return `msg-${String(guild.messages.length)}`;
    },
  };
}

export function addFakeMember(
  guild: FakeGuild,
  discordId: string,
  options: {
    roles?: readonly string[];
    position?: number;
    isGuildOwner?: boolean;
    displayName?: string;
    bot?: boolean;
    avatar?: string | null;
  } = {},
): FakeMember {
  const member: FakeMember = {
    discordId,
    username: `user${discordId.slice(-4)}`,
    displayName: options.displayName ?? `User ${discordId.slice(-4)}`,
    roles: new Set(options.roles ?? []),
    highestRolePosition: options.position ?? 1,
    isGuildOwner: options.isGuildOwner ?? false,
    present: true,
    bot: options.bot ?? false,
    avatar: options.avatar ?? null,
  };
  guild.members.set(discordId, member);
  return member;
}

export function snapshotOf(member: FakeMember): GuildMemberSnapshot {
  return {
    discordId: member.discordId,
    username: member.username,
    displayName: member.displayName,
    roleIds: new Set(member.roles),
    highestRolePosition: member.highestRolePosition,
    isGuildOwner: member.isGuildOwner,
    bot: member.bot,
    avatar: member.avatar,
  };
}

export interface FakeGatewayOptions {
  /** Fa fallire `applyRoleDiff`: serve a testare la compensazione. */
  failRoleUpdates?: boolean;
}

export function createFakeGateway(
  guild: FakeGuild,
  options: FakeGatewayOptions = {},
): RoleGateway & { options: FakeGatewayOptions } {
  const gateway = {
    options,

    async fetchMember(discordId: string): Promise<GuildMemberSnapshot | null> {
      const member = guild.members.get(discordId);
      return member?.present ? snapshotOf(member) : null;
    },

    canManageRole(roleId: string): boolean {
      return !guild.unmanageableRoles.has(roleId);
    },

    async applyRoleDiff(
      discordId: string,
      diff: { add?: readonly string[]; remove?: readonly string[] },
    ): Promise<GuildMemberSnapshot> {
      if (gateway.options.failRoleUpdates === true) {
        throw new Error('Discord API non raggiungibile (simulato)');
      }

      const member = guild.members.get(discordId);
      if (!member?.present) throw new Error('Membro assente dalla guild');

      for (const roleId of diff.remove ?? []) member.roles.delete(roleId);
      for (const roleId of diff.add ?? []) member.roles.add(roleId);

      return snapshotOf(member);
    },

    async tryNotify(
      discordId: string,
      content: { title: string; description: string },
    ): Promise<boolean> {
      guild.notifications.push({ discordId, title: content.title });
      return true;
    },
  };

  return gateway;
}

export interface Harness {
  env: Env;
  roles: RoleRegistry;
  store: InMemoryStore;
  repos: Repositories;
  guild: FakeGuild;
  gateway: ReturnType<typeof createFakeGateway>;
  audit: AuditService;
  announcements: ReturnType<typeof createRankAnnouncementService>;
  roleService: ReturnType<typeof createRoleService>;
  authorization: ReturnType<typeof createAuthorizationService>;
  verification: ReturnType<typeof createVerificationService>;
  members: ReturnType<typeof createMemberService>;
  applications: ReturnType<typeof createTtpApplicationService>;
  blacklist: ReturnType<typeof createBlacklistService>;
  community: ReturnType<typeof createCommunityService>;
  consistency: ReturnType<typeof createConsistencyService>;
}

export function createHarness(): Harness {
  const env = testEnv();
  const roles = buildRoleRegistry(env);
  const store = createStore();
  const repos = createInMemoryRepositories(store);
  const guild = createFakeGuild();
  const gateway = createFakeGateway(guild);

  const roleService = createRoleService({ roles, gateway });
  // Nessun sink Discord nei test: l'audit finisce solo a "database".
  const audit = createAuditService({ audit: repos.audit });

  const authorization = createAuthorizationService({
    repos,
    roles: roleService,
    gateway,
    guildId: GUILD_ID,
    ownerId: OWNER_ID,
  });

  const verification = createVerificationService({ repos, roles: roleService, gateway, audit });

  const announcements = createRankAnnouncementService({
    messages: createFakeMessageGateway(guild),
    channelId: CHANNEL_IDS.putOnOff,
  });

  const members = createMemberService({
    repos,
    roles: roleService,
    roleRegistry: roles,
    gateway,
    audit,
    announcements,
    guildId: GUILD_ID,
  });

  const applications = createTtpApplicationService({
    repos,
    members,
    roles: roleService,
    gateway,
    audit,
  });

  const blacklist = createBlacklistService({
    repos,
    roles: roleService,
    gateway,
    audit,
    guildId: GUILD_ID,
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
    listGuildMembersWithRoles: async (roleIds) =>
      [...guild.members.values()]
        .filter((m) => m.present && roleIds.some((id) => m.roles.has(id)))
        .map(snapshotOf),
  });

  const consistency = createConsistencyService({
    repos,
    roles: roleService,
    roleRegistry: roles,
    listAllGuildMembers: async () =>
      [...guild.members.values()].filter((m) => m.present).map(snapshotOf),
  });

  return {
    env,
    roles,
    store,
    repos,
    guild,
    gateway,
    audit,
    announcements,
    roleService,
    authorization,
    verification,
    members,
    applications,
    blacklist,
    community,
    consistency,
  };
}

/** Dati validi per il modal di verifica. */
export function validForm(overrides: Partial<RawVerificationForm> = {}): RawVerificationForm {
  return {
    rpName: 'Tony Montana',
    oocName: 'Andrea',
    ...overrides,
  };
}

/** Completa la verifica di un utente. */
export async function verifyUser(
  harness: Harness,
  discordId: string,
  overrides: Partial<RawVerificationForm> = {},
): Promise<void> {
  if (!harness.guild.members.has(discordId)) {
    addFakeMember(harness.guild, discordId);
  }
  await harness.verification.verify({
    discordId,
    username: `user${discordId.slice(-4)}`,
    displayName: `User ${discordId.slice(-4)}`,
    form: validForm(overrides),
  });
}
