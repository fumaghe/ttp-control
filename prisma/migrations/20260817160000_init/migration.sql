-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "MemberRank" AS ENUM ('RESIDENT', 'GANGSTER', 'YOUNG_OG', 'BIG', 'OG');

-- CreateEnum
CREATE TYPE "MemberStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'PERMADEATH', 'LEFT');

-- CreateEnum
CREATE TYPE "TtpApplicationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SpecialRole" AS ENUM ('SHOOTER', 'MAIN_SHOOTER', 'HONOR_1', 'HONOR_2', 'SUPPORTER', 'FIRST_DAY');

-- CreateEnum
CREATE TYPE "MemberHistoryEvent" AS ENUM ('JOINED_TTP', 'LEFT_TTP', 'PROMOTED', 'DEMOTED', 'RANK_CHANGED', 'SET_INACTIVE', 'SET_ACTIVE', 'SPECIAL_ROLE_ADDED', 'SPECIAL_ROLE_REMOVED', 'PERMADEATH');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('USER_VERIFIED', 'VERIFICATION_REVOKED', 'TTP_APPLICATION_CREATED', 'TTP_APPLICATION_APPROVED', 'TTP_APPLICATION_REJECTED', 'TTP_APPLICATION_CANCELLED', 'TTP_ADDED', 'TTP_REMOVED', 'PROMOTED', 'DEMOTED', 'RANK_CHANGED', 'SPECIAL_ROLE_ADDED', 'SPECIAL_ROLE_REMOVED', 'SET_INACTIVE', 'SET_ACTIVE', 'MEMBER_NOTES_UPDATED', 'COMMUNITY_ROLE_GRANTED', 'COMMUNITY_ROLE_REVOKED', 'BLACKLISTED', 'UNBLACKLISTED', 'PERMADEATH', 'KICKED', 'BANNED', 'ROLE_SYNC_WARNING', 'MEMBER_JOINED_DISCORD', 'MEMBER_LEFT_DISCORD', 'BLACKLISTED_USER_REJOINED', 'SETUP_RUN', 'SYNC_CHECK_RUN', 'PANEL_PUBLISHED');

-- CreateEnum
CREATE TYPE "PanelType" AS ENUM ('VERIFY', 'CONTROL_PANEL');

-- CreateTable
CREATE TABLE "discord_profiles" (
    "discordId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "displayName" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "discord_profiles_pkey" PRIMARY KEY ("discordId")
);

-- CreateTable
CREATE TABLE "verifications" (
    "id" TEXT NOT NULL,
    "discordId" TEXT NOT NULL,
    "rpName" TEXT NOT NULL,
    "rpSurname" TEXT NOT NULL,
    "citizenId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "referral" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedByDiscordId" TEXT,
    "revokeReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ttp_applications" (
    "id" TEXT NOT NULL,
    "discordId" TEXT NOT NULL,
    "status" "TtpApplicationStatus" NOT NULL DEFAULT 'PENDING',
    "pendingForDiscordId" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "reviewedByDiscordId" TEXT,
    "rejectionReason" TEXT,
    "initialRank" "MemberRank",
    "notes" TEXT,
    "channelId" TEXT,
    "messageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ttp_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "members" (
    "id" TEXT NOT NULL,
    "discordId" TEXT NOT NULL,
    "rpName" TEXT,
    "rpSurname" TEXT,
    "citizenId" TEXT,
    "phone" TEXT,
    "rank" "MemberRank" NOT NULL,
    "status" "MemberStatus" NOT NULL DEFAULT 'ACTIVE',
    "joinedTtpAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftTtpAt" TIMESTAMP(3),
    "recruitedByDiscordId" TEXT,
    "notes" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member_special_roles" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "role" "SpecialRole" NOT NULL,
    "activeKey" TEXT,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedByDiscordId" TEXT,
    "removedAt" TIMESTAMP(3),
    "removedByDiscordId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "member_special_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member_history" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "discordId" TEXT NOT NULL,
    "event" "MemberHistoryEvent" NOT NULL,
    "fromRank" "MemberRank",
    "toRank" "MemberRank",
    "fromStatus" "MemberStatus",
    "toStatus" "MemberStatus",
    "specialRole" "SpecialRole",
    "actorDiscordId" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blacklist_entries" (
    "id" TEXT NOT NULL,
    "discordId" TEXT NOT NULL,
    "rpName" TEXT,
    "rpSurname" TEXT,
    "reason" TEXT NOT NULL,
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "activeKey" TEXT,
    "createdByDiscordId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedByDiscordId" TEXT,
    "removedAt" TIMESTAMP(3),
    "removeReason" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "blacklist_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "action" "AuditAction" NOT NULL,
    "actorDiscordId" TEXT,
    "targetDiscordId" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "previousValue" TEXT,
    "newValue" TEXT,
    "reason" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guild_configs" (
    "guildId" TEXT NOT NULL,
    "bigCanManageBig" BOOLEAN NOT NULL DEFAULT false,
    "bigCanPromoteToLeadership" BOOLEAN NOT NULL DEFAULT false,
    "bigCanBlacklist" BOOLEAN NOT NULL DEFAULT true,
    "bigCanUseControlPanel" BOOLEAN NOT NULL DEFAULT true,
    "youngOgCanReviewApplications" BOOLEAN NOT NULL DEFAULT false,
    "blacklistAutoKick" BOOLEAN NOT NULL DEFAULT false,
    "blacklistAutoBan" BOOLEAN NOT NULL DEFAULT false,
    "removeSpecialRolesOnLeave" BOOLEAN NOT NULL DEFAULT true,
    "removeCommunityRolesOnJoin" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "guild_configs_pkey" PRIMARY KEY ("guildId")
);

-- CreateTable
CREATE TABLE "persistent_panels" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "panelType" "PanelType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "persistent_panels_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "discord_profiles_verifiedAt_idx" ON "discord_profiles"("verifiedAt");

-- CreateIndex
CREATE UNIQUE INDEX "verifications_discordId_key" ON "verifications"("discordId");

-- CreateIndex
CREATE INDEX "verifications_citizenId_idx" ON "verifications"("citizenId");

-- CreateIndex
CREATE INDEX "verifications_revokedAt_idx" ON "verifications"("revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ttp_applications_pendingForDiscordId_key" ON "ttp_applications"("pendingForDiscordId");

-- CreateIndex
CREATE INDEX "ttp_applications_discordId_status_idx" ON "ttp_applications"("discordId", "status");

-- CreateIndex
CREATE INDEX "ttp_applications_status_requestedAt_idx" ON "ttp_applications"("status", "requestedAt");

-- CreateIndex
CREATE UNIQUE INDEX "members_discordId_key" ON "members"("discordId");

-- CreateIndex
CREATE INDEX "members_status_rank_idx" ON "members"("status", "rank");

-- CreateIndex
CREATE INDEX "members_rank_idx" ON "members"("rank");

-- CreateIndex
CREATE UNIQUE INDEX "member_special_roles_activeKey_key" ON "member_special_roles"("activeKey");

-- CreateIndex
CREATE INDEX "member_special_roles_memberId_role_idx" ON "member_special_roles"("memberId", "role");

-- CreateIndex
CREATE INDEX "member_history_memberId_createdAt_idx" ON "member_history"("memberId", "createdAt");

-- CreateIndex
CREATE INDEX "member_history_discordId_createdAt_idx" ON "member_history"("discordId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "blacklist_entries_activeKey_key" ON "blacklist_entries"("activeKey");

-- CreateIndex
CREATE INDEX "blacklist_entries_discordId_active_idx" ON "blacklist_entries"("discordId", "active");

-- CreateIndex
CREATE INDEX "blacklist_entries_active_createdAt_idx" ON "blacklist_entries"("active", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_action_createdAt_idx" ON "audit_logs"("action", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_targetDiscordId_createdAt_idx" ON "audit_logs"("targetDiscordId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_actorDiscordId_createdAt_idx" ON "audit_logs"("actorDiscordId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "persistent_panels_guildId_panelType_key" ON "persistent_panels"("guildId", "panelType");

-- AddForeignKey
ALTER TABLE "verifications" ADD CONSTRAINT "verifications_discordId_fkey" FOREIGN KEY ("discordId") REFERENCES "discord_profiles"("discordId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ttp_applications" ADD CONSTRAINT "ttp_applications_discordId_fkey" FOREIGN KEY ("discordId") REFERENCES "discord_profiles"("discordId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "members" ADD CONSTRAINT "members_discordId_fkey" FOREIGN KEY ("discordId") REFERENCES "discord_profiles"("discordId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_special_roles" ADD CONSTRAINT "member_special_roles_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_history" ADD CONSTRAINT "member_history_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

