/**
 * Composizione del repository layer.
 *
 * E' l'unico punto in cui si passa il Prisma Client: i service ricevono
 * `Repositories` e non sanno che dietro c'e' Prisma.
 */
import type { Database } from '../database/prisma.js';
import { createAuditRepository } from './prisma/auditRepository.js';
import { createBlacklistRepository } from './prisma/blacklistRepository.js';
import { createDiscordProfileRepository } from './prisma/discordProfileRepository.js';
import { createGuildConfigRepository } from './prisma/guildConfigRepository.js';
import { createGuildMemberSnapshotRepository } from './prisma/guildMemberSnapshotRepository.js';
import { createMemberHistoryRepository } from './prisma/memberHistoryRepository.js';
import { createMemberRepository } from './prisma/memberRepository.js';
import { createMemberSpecialRoleRepository } from './prisma/memberSpecialRoleRepository.js';
import { createPersistentPanelRepository } from './prisma/persistentPanelRepository.js';
import { createTtpApplicationRepository } from './prisma/ttpApplicationRepository.js';
import { createVerificationRepository } from './prisma/verificationRepository.js';
import type { Repositories } from './types.js';

export function createRepositories(db: Database): Repositories {
  return {
    profiles: createDiscordProfileRepository(db),
    verifications: createVerificationRepository(db),
    applications: createTtpApplicationRepository(db),
    members: createMemberRepository(db),
    history: createMemberHistoryRepository(db),
    specialRoles: createMemberSpecialRoleRepository(db),
    blacklist: createBlacklistRepository(db),
    audit: createAuditRepository(db),
    guildConfig: createGuildConfigRepository(db),
    panels: createPersistentPanelRepository(db),
    snapshots: createGuildMemberSnapshotRepository(db),
  };
}

export type * from './types.js';
