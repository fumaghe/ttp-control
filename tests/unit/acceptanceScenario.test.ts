/**
 * Scenario di accettazione, dal punto di vista di chi usa il gestionale.
 *
 * Non verifica unità: ripercorre la sequenza reale di gesti che un operatore
 * compie nella UI di Discord, e controlla che il database, il roster e le
 * statistiche la seguano da soli. È il test che fallirebbe se i pezzi
 * funzionassero singolarmente ma non insieme.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { MemberRank, MemberStatus, SpecialRole } from '../../src/generated/prisma/enums.js';
import { createMemberReconciliationService } from '../../src/services/memberReconciliationService.js';
import { createStatsService } from '../../src/services/statsService.js';
import type { GuildMemberSnapshot } from '../../src/services/roleGateway.js';
import {
  addFakeMember,
  CHANNEL_IDS,
  createHarness,
  GUILD_ID,
  ROLE_IDS,
  snapshotOf,
  type Harness,
} from '../support/harness.js';

const RECRUIT = '400000000000000050';

let h: Harness;

function snapshots(): GuildMemberSnapshot[] {
  return [...h.guild.members.values()].filter((member) => member.present).map(snapshotOf);
}

function cron() {
  return createMemberReconciliationService({
    repos: h.repos,
    roleRegistry: h.roles,
    audit: h.audit,
    blacklist: h.blacklist,
    roleImport: h.roleImport,
    mode: 'IMPORT_SAFE',
    listAllGuildMembers: () => Promise.resolve(snapshots()),
    guildId: GUILD_ID,
  });
}

function roles(discordId: string): Set<string> {
  const member = h.guild.members.get(discordId);
  if (!member) throw new Error(`Membro finto ${discordId} inesistente`);
  return member.roles;
}

function putOnOff(): number {
  return h.guild.messages.filter((m) => m.channelId === CHANNEL_IDS.putOnOff).length;
}

beforeEach(() => {
  h = createHarness();
});

describe('un intero ciclo di vita gestito solo dai ruoli Discord', () => {
  it('dall’ingresso alla pausa, senza usare un solo comando', async () => {
    const tick = cron();

    // --- Il server esiste già, con una recluta che non ha ancora niente ----
    addFakeMember(h.guild, RECRUIT, { displayName: 'Tony Montana', position: 1 });
    await tick.run();

    expect(await h.repos.members.findByDiscordId(RECRUIT)).toBeNull();

    // --- 1. Un OG gli assegna Verified + TTP + Resident dalla UI -----------
    roles(RECRUIT).add(ROLE_IDS.verified);
    roles(RECRUIT).add(ROLE_IDS.ttp);
    roles(RECRUIT).add(ROLE_IDS.resident);
    await tick.run();

    // Compare nel database, nel roster e nelle statistiche.
    const member = await h.repos.members.findByDiscordId(RECRUIT);
    expect(member?.rank).toBe(MemberRank.RESIDENT);
    expect(member?.status).toBe(MemberStatus.ACTIVE);
    expect((await h.members.roster()).map((m) => m.discordId)).toContain(RECRUIT);

    const stats = await createStatsService({ repos: h.repos }).dashboard();
    expect(stats.ttpMembers).toBe(1);
    expect(stats.active).toBe(1);
    expect(stats.byRank[MemberRank.RESIDENT]).toBe(1);

    // La verifica è stata importata insieme all'ingresso.
    expect(await h.repos.verifications.findActive(RECRUIT)).not.toBeNull();
    // Nessun Put On per l'ingresso.
    expect(putOnOff()).toBe(0);

    // --- 2. Lo promuovono a Loc, sempre dalla UI --------------------------
    roles(RECRUIT).delete(ROLE_IDS.resident);
    roles(RECRUIT).add(ROLE_IDS.loc);
    await tick.run();

    expect((await h.repos.members.findByDiscordId(RECRUIT))?.rank).toBe(MemberRank.LOC);
    // Esattamente un annuncio per un cambio di rank.
    expect(putOnOff()).toBe(1);

    // --- 3. Gli danno un badge e lo mettono in pausa ----------------------
    roles(RECRUIT).add(ROLE_IDS.shooter);
    roles(RECRUIT).add(ROLE_IDS.inactive);
    await tick.run();

    const paused = await h.repos.members.findByDiscordId(RECRUIT);
    expect(paused?.status).toBe(MemberStatus.INACTIVE);
    expect(await h.members.listSpecialRoles(paused?.id ?? '')).toEqual([SpecialRole.SHOOTER]);
    expect(putOnOff()).toBe(1); // nessun annuncio per badge o pausa

    // --- 4. Torna attivo --------------------------------------------------
    roles(RECRUIT).delete(ROLE_IDS.inactive);
    await tick.run();
    expect((await h.repos.members.findByDiscordId(RECRUIT))?.status).toBe(MemberStatus.ACTIVE);

    // --- 5. Qualcuno gli toglie TTP a mano: NON è un'uscita ---------------
    roles(RECRUIT).delete(ROLE_IDS.ttp);
    const report = await tick.run();

    expect(report.warnings).toBeGreaterThan(0);
    const stillThere = await h.repos.members.findByDiscordId(RECRUIT);
    expect(stillThere?.status).toBe(MemberStatus.ACTIVE);
    expect(stillThere?.rank).toBe(MemberRank.LOC);

    // La diagnostica lo mostra come NON importabile: serve `/member remove`.
    const check = await h.consistency.run();
    const issues = check.issues.filter((issue) => issue.discordId === RECRUIT);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((issue) => !issue.importable)).toBe(true);

    // --- 6. Nessun loop: i cron successivi non producono altro ------------
    const historyBefore = h.store.history.length;
    await tick.run();
    await tick.run();
    expect(h.store.history.length).toBe(historyBefore);
    expect(putOnOff()).toBe(1);
  });
});
