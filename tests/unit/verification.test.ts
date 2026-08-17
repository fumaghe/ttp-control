/**
 * Verifica della community.
 *
 * L'invariante sotto test è quella centrale del progetto:
 * la verifica assegna `Verified` e MAI `TTP`.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { AuditAction } from '../../src/generated/prisma/enums.js';
import { ERROR_CODE } from '../../src/errors/AppError.js';
import {
  addFakeMember,
  createHarness,
  ROLE_IDS,
  validForm,
  verifyUser,
  type Harness,
} from '../support/harness.js';

const USER = '900000000000000001';
const ADMIN = '900000000000000099';

let h: Harness;

beforeEach(() => {
  h = createHarness();
});

describe('verifica valida', () => {
  it('assegna il ruolo Verified', async () => {
    addFakeMember(h.guild, USER);

    const outcome = await h.verification.verify({
      discordId: USER,
      username: 'tony',
      displayName: 'Tony',
      form: validForm(),
    });

    expect(outcome.kind).toBe('verified');
    expect(h.guild.members.get(USER)?.roles.has(ROLE_IDS.verified)).toBe(true);
  });

  it('NON assegna mai il ruolo TTP', async () => {
    addFakeMember(h.guild, USER);
    await verifyUser(h, USER);

    const roles = h.guild.members.get(USER)?.roles;
    expect(roles?.has(ROLE_IDS.ttp)).toBe(false);
    // Nemmeno un rank della gerarchia deve comparire.
    for (const rankRole of [
      ROLE_IDS.resident,
      ROLE_IDS.tinyLoc,
      ROLE_IDS.originalTinyLoc,
      ROLE_IDS.bigHomie,
      ROLE_IDS.og,
    ]) {
      expect(roles?.has(rankRole)).toBe(false);
    }
  });

  it('non richiede alcuna approvazione della Leadership', async () => {
    addFakeMember(h.guild, USER);
    await verifyUser(h, USER);

    // Nessuna candidatura viene creata: la verifica è autonoma.
    expect(await h.repos.applications.countPending()).toBe(0);
    expect(h.guild.members.get(USER)?.roles.has(ROLE_IDS.verified)).toBe(true);
  });

  it('registra la verifica a database e scrive l’audit', async () => {
    addFakeMember(h.guild, USER);
    await verifyUser(h, USER);

    const record = await h.repos.verifications.findActive(USER);
    expect(record).not.toBeNull();
    expect(record?.rpName).toBe('Tony Montana');

    expect(h.store.audit.some((entry) => entry.action === AuditAction.USER_VERIFIED)).toBe(true);
  });

  it('normalizza gli spazi nei campi', async () => {
    addFakeMember(h.guild, USER);
    await verifyUser(h, USER, { rpName: '  Tony   Junior  ' });

    const record = await h.repos.verifications.findActive(USER);
    expect(record?.rpName).toBe('Tony Junior');
  });
});

describe('un utente Verified può restare non-TTP', () => {
  it('è lo stato normale della community', async () => {
    addFakeMember(h.guild, USER);
    await verifyUser(h, USER);

    expect(h.guild.members.get(USER)?.roles.has(ROLE_IDS.verified)).toBe(true);
    expect(await h.members.find(USER)).toBeNull();
  });
});

describe('blacklist', () => {
  it('impedisce la verifica', async () => {
    addFakeMember(h.guild, USER);
    addFakeMember(h.guild, ADMIN, { roles: [ROLE_IDS.og], position: 10 });

    await h.blacklist.add({
      discordId: USER,
      reason: 'Comportamento tossico',
      actorDiscordId: ADMIN,
    });

    await expect(verifyUser(h, USER)).rejects.toMatchObject({
      code: ERROR_CODE.BLACKLISTED,
    });

    expect(h.guild.members.get(USER)?.roles.has(ROLE_IDS.verified)).toBe(false);
    expect(await h.repos.verifications.findActive(USER)).toBeNull();
  });

  it('registra il tentativo per la Leadership', async () => {
    addFakeMember(h.guild, USER);
    addFakeMember(h.guild, ADMIN, { roles: [ROLE_IDS.og], position: 10 });
    await h.blacklist.add({ discordId: USER, reason: 'Motivo', actorDiscordId: ADMIN });

    await expect(verifyUser(h, USER)).rejects.toThrow();

    expect(
      h.store.audit.some((entry) => entry.action === AuditAction.BLACKLISTED_USER_REJOINED),
    ).toBe(true);
  });
});

describe('idempotenza', () => {
  it('una seconda verifica non fallisce e non duplica nulla', async () => {
    addFakeMember(h.guild, USER);
    await verifyUser(h, USER);

    const second = await h.verification.verify({
      discordId: USER,
      username: 'tony',
      displayName: 'Tony',
      form: validForm(),
    });

    expect(second.kind).toBe('already-verified');
    expect(h.store.verifications.size).toBe(1);
  });

  it('riallinea il ruolo se è stato tolto a mano', async () => {
    addFakeMember(h.guild, USER);
    await verifyUser(h, USER);

    h.guild.members.get(USER)?.roles.delete(ROLE_IDS.verified);

    const second = await h.verification.verify({
      discordId: USER,
      username: 'tony',
      displayName: 'Tony',
      form: validForm(),
    });

    expect(second.kind).toBe('already-verified');
    expect(h.guild.members.get(USER)?.roles.has(ROLE_IDS.verified)).toBe(true);
  });
});

describe('utente non più nel server', () => {
  it('la verifica viene rifiutata', async () => {
    const member = addFakeMember(h.guild, USER);
    member.present = false;

    await expect(verifyUser(h, USER)).rejects.toMatchObject({
      code: ERROR_CODE.TARGET_LEFT_GUILD,
    });
  });
});
