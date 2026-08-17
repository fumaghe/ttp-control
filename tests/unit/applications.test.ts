/**
 * Candidature TTP: il confine fra `Verified` e membership effettiva.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { AuditAction, MemberRank, TtpApplicationStatus } from '../../src/generated/prisma/enums.js';
import { ERROR_CODE } from '../../src/errors/AppError.js';
import {
  addFakeMember,
  createHarness,
  ROLE_IDS,
  verifyUser,
  type Harness,
} from '../support/harness.js';

const USER = '900000000000000001';
const OG = '900000000000000010';

let h: Harness;

beforeEach(() => {
  h = createHarness();
  addFakeMember(h.guild, OG, { roles: [ROLE_IDS.ttp, ROLE_IDS.og], position: 90 });
});

async function verifiedUser(): Promise<void> {
  addFakeMember(h.guild, USER, { position: 1 });
  await verifyUser(h, USER);
}

describe('creazione', () => {
  it('richiede la verifica', async () => {
    addFakeMember(h.guild, USER);

    await expect(
      h.applications.create({ discordId: USER, username: 'tony', displayName: 'Tony' }),
    ).rejects.toMatchObject({ code: ERROR_CODE.NOT_VERIFIED });
  });

  it('un utente Verified può candidarsi', async () => {
    await verifiedUser();
    const application = await h.applications.create({
      discordId: USER,
      username: 'tony',
      displayName: 'Tony',
    });

    expect(application.status).toBe(TtpApplicationStatus.PENDING);
    // La candidatura da sola non dà nessun ruolo.
    expect(h.guild.members.get(USER)?.roles.has(ROLE_IDS.ttp)).toBe(false);
  });

  it('rifiuta una seconda candidatura PENDING', async () => {
    await verifiedUser();
    await h.applications.create({ discordId: USER, username: 'tony', displayName: 'Tony' });

    await expect(
      h.applications.create({ discordId: USER, username: 'tony', displayName: 'Tony' }),
    ).rejects.toMatchObject({ code: ERROR_CODE.APPLICATION_EXISTS });

    expect(await h.repos.applications.countPending()).toBe(1);
  });

  it('rifiuta chi è in blacklist', async () => {
    await verifiedUser();
    await h.blacklist.add({ discordId: USER, reason: 'Motivo', actorDiscordId: OG });

    await expect(
      h.applications.create({ discordId: USER, username: 'tony', displayName: 'Tony' }),
    ).rejects.toMatchObject({ code: ERROR_CODE.BLACKLISTED });
  });

  it('rifiuta chi è già membro', async () => {
    await verifiedUser();
    await h.members.addToGang({ discordId: USER, actorDiscordId: OG, source: 'manual' });

    await expect(
      h.applications.create({ discordId: USER, username: 'tony', displayName: 'Tony' }),
    ).rejects.toMatchObject({ code: ERROR_CODE.ALREADY_TTP });
  });
});

describe('approvazione', () => {
  async function pendingApplication(): Promise<string> {
    await verifiedUser();
    const application = await h.applications.create({
      discordId: USER,
      username: 'tony',
      displayName: 'Tony',
    });
    return application.id;
  }

  it('è l’operazione che assegna davvero il ruolo TTP', async () => {
    const id = await pendingApplication();
    await h.applications.approve({ applicationId: id, actorDiscordId: OG });

    expect(h.guild.members.get(USER)?.roles.has(ROLE_IDS.ttp)).toBe(true);
  });

  it('assegna RESIDENT come rank iniziale di default', async () => {
    const id = await pendingApplication();
    const outcome = await h.applications.approve({ applicationId: id, actorDiscordId: OG });

    expect(outcome.rank).toBe(MemberRank.RESIDENT);
    expect(h.guild.members.get(USER)?.roles.has(ROLE_IDS.resident)).toBe(true);
  });

  it('produce la combinazione Verified + TTP + Resident', async () => {
    const id = await pendingApplication();
    await h.applications.approve({ applicationId: id, actorDiscordId: OG });

    const roles = h.guild.members.get(USER)?.roles;
    expect(roles?.has(ROLE_IDS.verified)).toBe(true);
    expect(roles?.has(ROLE_IDS.ttp)).toBe(true);
    expect(roles?.has(ROLE_IDS.resident)).toBe(true);
  });

  it('crea il record Member', async () => {
    const id = await pendingApplication();
    await h.applications.approve({ applicationId: id, actorDiscordId: OG });

    const member = await h.members.find(USER);
    expect(member).not.toBeNull();
    expect(member?.joinedTtpAt).toBeInstanceOf(Date);
    expect(member?.recruitedByDiscordId).toBe(OG);
  });

  it('un secondo click fallisce con eleganza', async () => {
    const id = await pendingApplication();
    await h.applications.approve({ applicationId: id, actorDiscordId: OG });

    await expect(
      h.applications.approve({ applicationId: id, actorDiscordId: OG }),
    ).rejects.toMatchObject({ code: ERROR_CODE.APPLICATION_NOT_PENDING });

    // Nessun membro duplicato.
    expect(h.store.members.size).toBe(1);
  });

  it('due approvazioni simultanee: una sola passa', async () => {
    const id = await pendingApplication();

    const results = await Promise.allSettled([
      h.applications.approve({ applicationId: id, actorDiscordId: OG }),
      h.applications.approve({ applicationId: id, actorDiscordId: OG }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    expect(h.store.members.size).toBe(1);
  });

  it('notifica il candidato', async () => {
    const id = await pendingApplication();
    await h.applications.approve({ applicationId: id, actorDiscordId: OG });

    expect(h.guild.notifications.some((n) => n.discordId === USER)).toBe(true);
  });

  it('scrive l’audit', async () => {
    const id = await pendingApplication();
    await h.applications.approve({ applicationId: id, actorDiscordId: OG });

    expect(h.store.audit.some((e) => e.action === AuditAction.TTP_APPLICATION_APPROVED)).toBe(true);
  });
});

describe('rifiuto', () => {
  async function pendingApplication(): Promise<string> {
    await verifiedUser();
    const application = await h.applications.create({
      discordId: USER,
      username: 'tony',
      displayName: 'Tony',
    });
    return application.id;
  }

  it('conserva il ruolo Verified', async () => {
    const id = await pendingApplication();
    await h.applications.reject({
      applicationId: id,
      actorDiscordId: OG,
      reason: 'Troppo poco tempo in città',
    });

    expect(h.guild.members.get(USER)?.roles.has(ROLE_IDS.verified)).toBe(true);
    expect(await h.repos.verifications.findActive(USER)).not.toBeNull();
  });

  it('non assegna TTP e non blacklista', async () => {
    const id = await pendingApplication();
    await h.applications.reject({ applicationId: id, actorDiscordId: OG, reason: 'Motivo' });

    expect(h.guild.members.get(USER)?.roles.has(ROLE_IDS.ttp)).toBe(false);
    expect(await h.blacklist.isBlacklisted(USER)).toBe(false);
    expect(await h.members.find(USER)).toBeNull();
  });

  it('registra la motivazione e il revisore', async () => {
    const id = await pendingApplication();
    const rejected = await h.applications.reject({
      applicationId: id,
      actorDiscordId: OG,
      reason: 'Motivazione precisa',
    });

    expect(rejected.status).toBe(TtpApplicationStatus.REJECTED);
    expect(rejected.rejectionReason).toBe('Motivazione precisa');
    expect(rejected.reviewedByDiscordId).toBe(OG);
    expect(rejected.reviewedAt).toBeInstanceOf(Date);
  });

  it('dopo il rifiuto ci si può ricandidare', async () => {
    const id = await pendingApplication();
    await h.applications.reject({ applicationId: id, actorDiscordId: OG, reason: 'Motivo' });

    const second = await h.applications.create({
      discordId: USER,
      username: 'tony',
      displayName: 'Tony',
    });
    expect(second.status).toBe(TtpApplicationStatus.PENDING);
  });
});

describe('annullamento', () => {
  it('il candidato può ritirare la propria richiesta', async () => {
    await verifiedUser();
    await h.applications.create({ discordId: USER, username: 'tony', displayName: 'Tony' });

    const cancelled = await h.applications.cancel({
      discordId: USER,
      actorDiscordId: USER,
    });

    expect(cancelled.status).toBe(TtpApplicationStatus.CANCELLED);
    expect(await h.repos.applications.countPending()).toBe(0);
  });
});
