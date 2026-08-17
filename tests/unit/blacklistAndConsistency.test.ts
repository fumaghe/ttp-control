/**
 * Blacklist, community e controllo di integrità dei dati.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { AuditAction, MemberRank, MemberStatus } from '../../src/generated/prisma/enums.js';
import { ERROR_CODE } from '../../src/errors/AppError.js';
import {
  addFakeMember,
  createHarness,
  ROLE_IDS,
  verifyUser,
  type Harness,
} from '../support/harness.js';

const USER = '900000000000000001';
const OTHER = '900000000000000002';
const OG = '900000000000000010';

let h: Harness;

beforeEach(() => {
  h = createHarness();
  addFakeMember(h.guild, OG, { roles: [ROLE_IDS.ttp, ROLE_IDS.og], position: 90 });
});

describe('blacklist', () => {
  it('revoca Verified quando viene aggiunta', async () => {
    addFakeMember(h.guild, USER);
    await verifyUser(h, USER);

    const outcome = await h.blacklist.add({
      discordId: USER,
      reason: 'Comportamento tossico',
      actorDiscordId: OG,
    });

    expect(outcome.verifiedRevoked).toBe(true);
    expect(h.guild.members.get(USER)?.roles.has(ROLE_IDS.verified)).toBe(false);
    expect(await h.repos.verifications.findActive(USER)).toBeNull();
  });

  it('NON banna né espelle di default', async () => {
    addFakeMember(h.guild, USER);
    await verifyUser(h, USER);

    const outcome = await h.blacklist.add({
      discordId: USER,
      reason: 'Motivo',
      actorDiscordId: OG,
    });

    expect(outcome.kicked).toBe(false);
    expect(outcome.banned).toBe(false);
  });

  it('è idempotente', async () => {
    addFakeMember(h.guild, USER);
    await h.blacklist.add({ discordId: USER, reason: 'Motivo', actorDiscordId: OG });
    const second = await h.blacklist.add({
      discordId: USER,
      reason: 'Altro motivo',
      actorDiscordId: OG,
    });

    expect(second.alreadyBlacklisted).toBe(true);
    expect(await h.blacklist.countActive()).toBe(1);
  });

  it('segnala se il target era un membro TTP', async () => {
    addFakeMember(h.guild, USER, { position: 1 });
    await verifyUser(h, USER);
    await h.members.addToGang({ discordId: USER, actorDiscordId: OG, source: 'manual' });

    const outcome = await h.blacklist.add({
      discordId: USER,
      reason: 'Tradimento',
      actorDiscordId: OG,
    });

    expect(outcome.wasTtpMember).toBe(true);
  });

  it('la rimozione conserva lo storico', async () => {
    addFakeMember(h.guild, USER);
    await h.blacklist.add({ discordId: USER, reason: 'Motivo', actorDiscordId: OG });
    await h.blacklist.remove({ discordId: USER, actorDiscordId: OG, reason: 'Riabilitato' });

    expect(await h.blacklist.isBlacklisted(USER)).toBe(false);
    const history = await h.blacklist.history(USER);
    expect(history).toHaveLength(1);
    expect(history[0]?.removedAt).not.toBeNull();
  });

  it('rimuovere chi non è in blacklist è un errore esplicito', async () => {
    addFakeMember(h.guild, USER);
    await expect(h.blacklist.remove({ discordId: USER, actorDiscordId: OG })).rejects.toMatchObject(
      { code: ERROR_CODE.NOT_BLACKLISTED },
    );
  });

  it('dopo la rimozione l’utente può riverificarsi', async () => {
    addFakeMember(h.guild, USER);
    await h.blacklist.add({ discordId: USER, reason: 'Motivo', actorDiscordId: OG });
    await h.blacklist.remove({ discordId: USER, actorDiscordId: OG });

    await verifyUser(h, USER);
    expect(h.guild.members.get(USER)?.roles.has(ROLE_IDS.verified)).toBe(true);
  });

  it('il rientro di un blacklistato genera un audit, non un ban', async () => {
    addFakeMember(h.guild, USER);
    await h.blacklist.add({ discordId: USER, reason: 'Motivo', actorDiscordId: OG });

    const entry = await h.blacklist.handleRejoin(USER, 'tony');

    expect(entry).not.toBeNull();
    expect(h.store.audit.some((e) => e.action === AuditAction.BLACKLISTED_USER_REJOINED)).toBe(
      true,
    );
  });
});

describe('community', () => {
  it('grantVerified assegna solo Verified, mai TTP', async () => {
    addFakeMember(h.guild, USER);
    await h.community.grantVerified({ discordId: USER, actorDiscordId: OG });

    const roles = h.guild.members.get(USER)?.roles;
    expect(roles?.has(ROLE_IDS.verified)).toBe(true);
    expect(roles?.has(ROLE_IDS.ttp)).toBe(false);
  });

  it('grantVerified rispetta la blacklist', async () => {
    addFakeMember(h.guild, USER);
    await h.blacklist.add({ discordId: USER, reason: 'Motivo', actorDiscordId: OG });

    await expect(
      h.community.grantVerified({ discordId: USER, actorDiscordId: OG }),
    ).rejects.toMatchObject({ code: ERROR_CODE.BLACKLISTED });
  });

  it('revoke rifiuta se il target è ancora TTP', async () => {
    addFakeMember(h.guild, USER, { position: 1 });
    await verifyUser(h, USER);
    await h.members.addToGang({ discordId: USER, actorDiscordId: OG, source: 'manual' });

    await expect(
      h.community.revokeAccess({
        discordId: USER,
        actorDiscordId: OG,
        reason: 'Motivo',
      }),
    ).rejects.toMatchObject({ code: ERROR_CODE.ALREADY_TTP });

    // Nessuno stato `TTP senza Verified` creato per sbaglio.
    expect(h.guild.members.get(USER)?.roles.has(ROLE_IDS.verified)).toBe(true);
  });

  it('revoke rimuove Verified, Friend e Mafia su un non-membro', async () => {
    addFakeMember(h.guild, USER, { roles: [ROLE_IDS.friend, ROLE_IDS.mafia] });
    await verifyUser(h, USER);

    await h.community.revokeAccess({
      discordId: USER,
      actorDiscordId: OG,
      reason: 'Uscita dalla community',
    });

    const roles = h.guild.members.get(USER)?.roles;
    expect(roles?.has(ROLE_IDS.verified)).toBe(false);
    expect(roles?.has(ROLE_IDS.friend)).toBe(false);
    expect(roles?.has(ROLE_IDS.mafia)).toBe(false);
  });

  it('assegnare Friend è idempotente', async () => {
    addFakeMember(h.guild, USER);
    const first = await h.community.setCommunityRole({
      discordId: USER,
      actorDiscordId: OG,
      role: 'friend',
      grant: true,
    });
    const second = await h.community.setCommunityRole({
      discordId: USER,
      actorDiscordId: OG,
      role: 'friend',
      grant: true,
    });

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
  });
});

describe('controllo di integrità', () => {
  it('non segnala nulla su uno stato coerente', async () => {
    addFakeMember(h.guild, USER, { position: 1 });
    await verifyUser(h, USER);
    await h.members.addToGang({ discordId: USER, actorDiscordId: OG, source: 'manual' });
    // L'OG di test è un membro solo su Discord: lo togliamo dal confronto.
    h.guild.members.delete(OG);

    const report = await h.consistency.run();
    expect(report.issues).toHaveLength(0);
    expect(report.validMembers).toBe(1);
  });

  it('rileva TTP senza Verified', async () => {
    addFakeMember(h.guild, USER, { roles: [ROLE_IDS.ttp, ROLE_IDS.resident] });
    h.guild.members.delete(OG);

    const report = await h.consistency.run();
    expect(report.issues.some((i) => i.kind === 'TTP_WITHOUT_VERIFIED')).toBe(true);
  });

  it('rileva due rank contemporaneamente', async () => {
    addFakeMember(h.guild, USER, {
      roles: [ROLE_IDS.verified, ROLE_IDS.ttp, ROLE_IDS.gangster, ROLE_IDS.youngOg],
    });
    h.guild.members.delete(OG);

    const report = await h.consistency.run();
    const issue = report.issues.find((i) => i.kind === 'MULTIPLE_RANKS');
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('error');
  });

  it('rileva un rank senza TTP', async () => {
    addFakeMember(h.guild, USER, { roles: [ROLE_IDS.verified, ROLE_IDS.big] });
    h.guild.members.delete(OG);

    const report = await h.consistency.run();
    expect(report.issues.some((i) => i.kind === 'RANK_WITHOUT_TTP')).toBe(true);
  });

  it('rileva il ruolo TTP senza record a database', async () => {
    addFakeMember(h.guild, USER, {
      roles: [ROLE_IDS.verified, ROLE_IDS.ttp, ROLE_IDS.resident],
    });
    await verifyUser(h, USER);
    h.guild.members.delete(OG);

    const report = await h.consistency.run();
    expect(report.issues.some((i) => i.kind === 'TTP_ROLE_WITHOUT_MEMBER_DB')).toBe(true);
  });

  it('rileva un membro a database senza il ruolo TTP', async () => {
    addFakeMember(h.guild, USER, { position: 1 });
    await verifyUser(h, USER);
    await h.members.addToGang({ discordId: USER, actorDiscordId: OG, source: 'manual' });
    // Un admin toglie il ruolo a mano.
    h.guild.members.get(USER)?.roles.delete(ROLE_IDS.ttp);
    h.guild.members.delete(OG);

    const report = await h.consistency.run();
    expect(report.issues.some((i) => i.kind === 'MEMBER_DB_WITHOUT_TTP_ROLE')).toBe(true);
  });

  it('rileva una discrepanza di rank fra Discord e database', async () => {
    addFakeMember(h.guild, USER, { position: 1 });
    await verifyUser(h, USER);
    await h.members.addToGang({
      discordId: USER,
      actorDiscordId: OG,
      rank: MemberRank.RESIDENT,
      source: 'manual',
    });
    const member = h.guild.members.get(USER);
    member?.roles.delete(ROLE_IDS.resident);
    member?.roles.add(ROLE_IDS.big);
    h.guild.members.delete(OG);

    const report = await h.consistency.run();
    expect(report.issues.some((i) => i.kind === 'RANK_MISMATCH')).toBe(true);
  });

  it('rileva un blacklistato che conserva l’accesso', async () => {
    addFakeMember(h.guild, USER, { roles: [ROLE_IDS.verified] });
    await h.repos.blacklist.add({
      discordId: USER,
      reason: 'Motivo',
      createdByDiscordId: OG,
    });
    h.guild.members.delete(OG);

    const report = await h.consistency.run();
    expect(report.issues.some((i) => i.kind === 'BLACKLISTED_WITH_ACCESS')).toBe(true);
  });

  it('non corregge automaticamente nulla', async () => {
    addFakeMember(h.guild, USER, { roles: [ROLE_IDS.ttp, ROLE_IDS.resident] });
    h.guild.members.delete(OG);

    const before = new Set(h.guild.members.get(USER)?.roles);
    await h.consistency.run();
    const after = new Set(h.guild.members.get(USER)?.roles);

    expect([...after]).toEqual([...before]);
  });

  it('rileva un membro attivo che ha lasciato il Discord', async () => {
    addFakeMember(h.guild, USER, { position: 1 });
    await verifyUser(h, USER);
    await h.members.addToGang({ discordId: USER, actorDiscordId: OG, source: 'manual' });

    const member = h.guild.members.get(USER);
    if (member) member.present = false;
    h.guild.members.delete(OG);

    const report = await h.consistency.run();
    expect(report.issues.some((i) => i.discordId === USER)).toBe(true);
    // Il record resta ACTIVE: nessuna modifica automatica.
    expect((await h.members.find(USER))?.status).toBe(MemberStatus.ACTIVE);
  });
});

describe('altri utenti non interferiscono', () => {
  it('la verifica di un utente non tocca gli altri', async () => {
    addFakeMember(h.guild, USER);
    addFakeMember(h.guild, OTHER);
    await verifyUser(h, USER);

    expect(h.guild.members.get(OTHER)?.roles.has(ROLE_IDS.verified)).toBe(false);
  });
});
