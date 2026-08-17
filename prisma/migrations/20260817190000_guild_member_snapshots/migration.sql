-- Snapshot dello stato Discord dei membri.
--
-- Sostituisce gli eventi Gateway guildMemberAdd / guildMemberRemove /
-- guildMemberUpdate: senza connessione persistente, il Cron Trigger confronta
-- lo stato attuale della guild con queste righe e ne deduce gli stessi eventi.

-- CreateTable
CREATE TABLE "guild_member_snapshots" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "discordId" TEXT NOT NULL,
    "inGuild" BOOLEAN NOT NULL DEFAULT true,
    "roleIds" TEXT[],
    "rolesHash" TEXT NOT NULL,
    "nickname" TEXT,
    "joinedAt" TIMESTAMP(3),
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMP(3),
    "lastReconciledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "guild_member_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "guild_member_snapshots_guildId_inGuild_idx" ON "guild_member_snapshots"("guildId", "inGuild");

-- CreateIndex
CREATE UNIQUE INDEX "guild_member_snapshots_guildId_discordId_key" ON "guild_member_snapshots"("guildId", "discordId");
