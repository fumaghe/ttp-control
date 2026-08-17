/**
 * Risoluzione dei contesti di authorization.
 *
 * Traduce lo stato reale (ruoli Discord + database + policy della guild) nei
 * contesti puri che `src/config/permissions.ts` sa valutare.
 *
 * L'authorization viene rifatta a OGNI interaction, anche sui bottoni di un
 * pannello generato in precedenza: che il pannello sia stato creato da un OG
 * non dice nulla su chi sta cliccando adesso.
 */
import type { MemberRank } from '../generated/prisma/enums.js';
import {
  type ActorContext,
  type AuthorizationDecision,
  can,
  canActOn,
  canAssignRank,
  type Operation,
  type PermissionPolicy,
  type TargetContext,
} from '../config/permissions.js';
import { AuthorizationError } from '../errors/AppError.js';
import type { Repositories } from '../repositories/types.js';
import type { RoleService } from './roleService.js';
import type { GuildMemberSnapshot, RoleGateway } from './roleGateway.js';

export interface AuthorizationService {
  /** Contesto dell'attore, letto da Discord nel momento del click. */
  resolveActor(discordId: string): Promise<ActorContext>;
  resolveActorFromSnapshot(snapshot: GuildMemberSnapshot): ActorContext;
  resolveTarget(discordId: string): Promise<TargetContext | null>;
  policy(): Promise<PermissionPolicy>;

  /** @throws AuthorizationError se non consentito. */
  require(actor: ActorContext, operation: Operation): Promise<void>;
  /** @throws AuthorizationError se non consentito su quel bersaglio. */
  requireOn(actor: ActorContext, target: TargetContext, operation: Operation): Promise<void>;
  /** @throws AuthorizationError se l'attore non puo' assegnare quel rank. */
  requireRankAssignment(actor: ActorContext, rank: MemberRank): Promise<void>;

  check(actor: ActorContext, operation: Operation): Promise<AuthorizationDecision>;
}

export function createAuthorizationService(deps: {
  repos: Repositories;
  roles: RoleService;
  gateway: RoleGateway;
  guildId: string;
  ownerId: string;
}): AuthorizationService {
  const { repos, roles, gateway, guildId, ownerId } = deps;

  async function policy(): Promise<PermissionPolicy> {
    const config = await repos.guildConfig.ensure(guildId);
    return {
      bigCanManageBig: config.bigCanManageBig,
      bigCanPromoteToLeadership: config.bigCanPromoteToLeadership,
      bigCanBlacklist: config.bigCanBlacklist,
      bigCanUseControlPanel: config.bigCanUseControlPanel,
      youngOgCanReviewApplications: config.youngOgCanReviewApplications,
    };
  }

  function fromSnapshot(snapshot: GuildMemberSnapshot): ActorContext {
    return {
      discordId: snapshot.discordId,
      isBotOwner: snapshot.discordId === ownerId,
      isGuildOwner: snapshot.isGuildOwner,
      isTtp: roles.isTtp(snapshot),
      // Il rank si legge dai RUOLI DISCORD, non dal database: e' lo stato che
      // l'utente ha davvero in questo istante.
      rank: roles.readRank(snapshot),
      highestRolePosition: snapshot.highestRolePosition,
    };
  }

  const service: AuthorizationService = {
    resolveActorFromSnapshot: fromSnapshot,

    async resolveActor(discordId: string): Promise<ActorContext> {
      const snapshot = await gateway.fetchMember(discordId);
      if (!snapshot) {
        // Fuori dalla guild non si amministra nulla — tranne l'owner del bot,
        // che deve poter intervenire sempre.
        return {
          discordId,
          isBotOwner: discordId === ownerId,
          isGuildOwner: false,
          isTtp: false,
          rank: undefined,
          highestRolePosition: 0,
        };
      }
      return fromSnapshot(snapshot);
    },

    async resolveTarget(discordId: string): Promise<TargetContext | null> {
      const snapshot = await gateway.fetchMember(discordId);
      if (!snapshot) return null;
      return {
        discordId,
        isTtp: roles.isTtp(snapshot),
        rank: roles.readRank(snapshot),
        highestRolePosition: snapshot.highestRolePosition,
      };
    },

    policy,

    async check(actor, operation): Promise<AuthorizationDecision> {
      return can(actor, operation, await policy());
    },

    async require(actor, operation): Promise<void> {
      const decision = can(actor, operation, await policy());
      if (!decision.allowed) {
        throw new AuthorizationError(decision.reason, {
          context: { operation, actor: actor.discordId },
        });
      }
    },

    async requireOn(actor, target, operation): Promise<void> {
      const decision = canActOn(actor, target, operation, await policy());
      if (!decision.allowed) {
        throw new AuthorizationError(decision.reason, {
          context: { operation, actor: actor.discordId, target: target.discordId },
        });
      }
    },

    async requireRankAssignment(actor, rank): Promise<void> {
      const decision = canAssignRank(actor, rank, await policy());
      if (!decision.allowed) {
        throw new AuthorizationError(decision.reason, {
          context: { actor: actor.discordId, rank },
        });
      }
    },
  };

  return service;
}
