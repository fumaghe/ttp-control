/**
 * Contesto applicativo: tutto cio' che un handler puo' usare.
 *
 * Viene costruito una volta sola allo startup (`src/client/createContext.ts`)
 * e passato a ogni comando e interaction. Nessun handler deve costruirsi i
 * propri service o toccare direttamente Prisma.
 */
import type { Client, Guild } from 'discord.js';
import type { Env } from '../config/env.js';
import type { ChannelRegistry } from '../config/channels.js';
import type { RoleRegistry } from '../config/roles.js';
import type { Database } from '../database/prisma.js';
import type { Repositories } from '../repositories/types.js';
import type { AuditService } from '../services/auditService.js';
import type { AuthorizationService } from '../services/authorizationService.js';
import type { BlacklistService } from '../services/blacklistService.js';
import type { CommunityService } from '../services/communityService.js';
import type { ConsistencyService } from '../services/consistencyService.js';
import type { MemberService } from '../services/memberService.js';
import type { RoleGateway, GuildMemberSnapshot } from '../services/roleGateway.js';
import type { RoleService } from '../services/roleService.js';
import type { StatsService } from '../services/statsService.js';
import type { TtpApplicationService } from '../services/ttpApplicationService.js';
import type { VerificationService } from '../services/verificationService.js';
import type { PanelService } from '../services/panelService.js';

export interface AppContext {
  readonly client: Client<true>;
  readonly guild: Guild;
  readonly env: Env;
  readonly db: Database;
  readonly repos: Repositories;
  readonly roles: RoleRegistry;
  readonly channels: ChannelRegistry;

  readonly gateway: RoleGateway;
  readonly roleService: RoleService;
  readonly audit: AuditService;
  readonly authorization: AuthorizationService;
  readonly verification: VerificationService;
  readonly applications: TtpApplicationService;
  readonly members: MemberService;
  readonly community: CommunityService;
  readonly blacklist: BlacklistService;
  readonly consistency: ConsistencyService;
  readonly stats: StatsService;
  readonly panels: PanelService;

  /** Enumerazione dei membri della guild (richiede l'intent GuildMembers). */
  readonly listAllGuildMembers: () => Promise<GuildMemberSnapshot[]>;
  readonly listGuildMembersWithRoles: (
    roleIds: readonly string[],
  ) => Promise<GuildMemberSnapshot[]>;

  /** Istante di avvio, per l'uptime di `/ping`. */
  readonly startedAt: Date;
}
