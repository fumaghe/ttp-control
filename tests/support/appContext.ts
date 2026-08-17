/**
 * `AppContext` di test, costruito sopra l'harness in memoria.
 *
 * Permette di esercitare il routing e gli handler reali — gli stessi che
 * girano sul Worker — senza database né Discord. Il gateway è quello finto
 * dell'harness, esteso con le poche operazioni REST che gli handler usano
 * (messaggi, enumerazione, permessi).
 */
import { buildChannelRegistry } from '../../src/config/channels.js';
import type { DiscordGateway } from '../../src/discord/gateway.js';
import type { MessagePayload } from '../../src/discord/payload.js';
import { createMemberReconciliationService } from '../../src/services/memberReconciliationService.js';
import { createPanelService } from '../../src/services/panelService.js';
import { createStatsService } from '../../src/services/statsService.js';
import type { GuildMemberSnapshot } from '../../src/services/roleGateway.js';
import type { AppContext } from '../../src/types/context.js';
import type { Database } from '../../src/database/prisma.js';
import { createHarness, GUILD_ID, type Harness } from './harness.js';

export interface SentMessage {
  readonly channelId: string;
  readonly payload: MessagePayload;
}

export interface TestAppContext {
  readonly ctx: AppContext;
  readonly harness: Harness;
  /** Messaggi inviati sui canali, in ordine. */
  readonly sent: SentMessage[];
  /** Messaggi modificati: `channelId:messageId`. */
  readonly edited: string[];
  /** Messaggi cancellati "a mano", che `editMessage` tratterà come assenti. */
  readonly deletedMessages: Set<string>;
}

let messageSequence = 0;

export function createTestAppContext(): TestAppContext {
  const harness = createHarness();
  const channels = buildChannelRegistry(harness.env);

  const sent: SentMessage[] = [];
  const edited: string[] = [];
  const deletedMessages = new Set<string>();

  const snapshots = (): GuildMemberSnapshot[] =>
    [...harness.guild.members.values()]
      .filter((member) => member.present)
      .map((member) => ({
        discordId: member.discordId,
        username: member.username,
        displayName: member.displayName,
        roleIds: new Set(member.roles),
        highestRolePosition: member.highestRolePosition,
        isGuildOwner: member.isGuildOwner,
      }));

  const gateway = {
    ...harness.gateway,
    guildId: GUILD_ID,

    getGuild: () =>
      Promise.resolve({ id: GUILD_ID, name: 'TTP — Impero', owner_id: '999999999999999999' }),
    getRoles: () => Promise.resolve([]),
    getChannels: () => Promise.resolve([]),
    getSelfMember: () => Promise.resolve({ roles: [] }),
    getSelfUserId: () => Promise.resolve(harness.env.clientId),

    getMember: (discordId: string) => harness.gateway.fetchMember(discordId),
    listMembers: () => Promise.resolve(snapshots()),
    listMembersWithAnyRole: (roleIds: readonly string[]) =>
      Promise.resolve(snapshots().filter((s) => roleIds.some((id) => s.roleIds.has(id)))),

    addRole: () => Promise.resolve(),
    removeRole: () => Promise.resolve(),
    setNickname: () => Promise.resolve(),

    sendMessage: (channelId: string, payload: MessagePayload) => {
      sent.push({ channelId, payload });
      messageSequence += 1;
      return Promise.resolve(`msg_${messageSequence}`);
    },
    editMessage: (channelId: string, messageId: string, _payload: MessagePayload) => {
      if (deletedMessages.has(messageId)) return Promise.resolve(false);
      edited.push(`${channelId}:${messageId}`);
      return Promise.resolve(true);
    },
    getMessage: () => Promise.resolve(null),
    sendDM: () => Promise.resolve(true),

    // PanelMessageGateway
    send: (channelId: string, payload: MessagePayload) => gateway.sendMessage(channelId, payload),
    edit: (channelId: string, messageId: string, payload: MessagePayload) =>
      gateway.editMessage(channelId, messageId, payload),

    kick: () => Promise.resolve(true),
    ban: () => Promise.resolve(true),

    selfGuildPermissions: () => Promise.resolve(0n),
    selfChannelPermissions: () => Promise.resolve(0n),
    canManageRoleAsync: () => Promise.resolve(true),
  } as unknown as DiscordGateway;

  const reconciliation = createMemberReconciliationService({
    repos: harness.repos,
    roles: harness.roleService,
    roleRegistry: harness.roles,
    audit: harness.audit,
    blacklist: harness.blacklist,
    listAllGuildMembers: () => Promise.resolve(snapshots()),
    guildId: GUILD_ID,
  });

  const ctx: AppContext = {
    env: harness.env,
    guildId: GUILD_ID,
    applicationId: harness.env.clientId,
    // Nessun handler sotto test tocca il database direttamente: passa tutto
    // dai repository in memoria.
    db: undefined as unknown as Database,
    repos: harness.repos,
    roles: harness.roles,
    channels,
    gateway,
    roleService: harness.roleService,
    audit: harness.audit,
    authorization: harness.authorization,
    verification: harness.verification,
    applications: harness.applications,
    members: harness.members,
    community: harness.community,
    blacklist: harness.blacklist,
    consistency: harness.consistency,
    stats: createStatsService({ repos: harness.repos }),
    panels: createPanelService({
      panels: harness.repos.panels,
      messages: gateway,
      guildId: GUILD_ID,
    }),
    reconciliation,
    listAllGuildMembers: () => Promise.resolve(snapshots()),
    listGuildMembersWithRoles: (roleIds) =>
      Promise.resolve(snapshots().filter((s) => roleIds.some((id) => s.roleIds.has(id)))),
    startedAt: new Date(),
  };

  return { ctx, harness, sent, edited, deletedMessages };
}
