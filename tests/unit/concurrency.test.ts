/**
 * Concorrenza, idempotenza e compensazione.
 *
 * Lo scenario che questi test devono escludere è quello descritto nel
 * capitolato: due promote simultanei che compongono
 * `Gangster → Young OG → Big`.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { AuditAction, MemberRank, MemberStatus } from '../../src/generated/prisma/enums.js';
import { KeyedMutex } from '../../src/utils/mutex.js';
import {
  addFakeMember,
  createHarness,
  ROLE_IDS,
  verifyUser,
  type Harness,
} from '../support/harness.js';

const USER = '900000000000000001';
const OG = '900000000000000010';

/** Tutti e nove i ruoli della gerarchia. */
const ALL_RANK_ROLE_IDS = [
  ROLE_IDS.resident,
  ROLE_IDS.gangBanger,
  ROLE_IDS.infantilLoc,
  ROLE_IDS.tinyLoc,
  ROLE_IDS.loc,
  ROLE_IDS.originalTinyLoc,
  ROLE_IDS.big,
  ROLE_IDS.bigHomie,
  ROLE_IDS.og,
];

let h: Harness;

async function joined(rank: MemberRank = MemberRank.TINY_LOC): Promise<void> {
  addFakeMember(h.guild, USER, { position: 1 });
  await verifyUser(h, USER);
  await h.members.addToGang({
    discordId: USER,
    actorDiscordId: OG,
    rank,
    source: 'manual',
  });
}

beforeEach(() => {
  h = createHarness();
  addFakeMember(h.guild, OG, { roles: [ROLE_IDS.ttp, ROLE_IDS.og], position: 90 });
});

describe('KeyedMutex', () => {
  it('serializza i task sulla stessa chiave', async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];

    const slow = mutex.run('k', async () => {
      order.push('start-1');
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push('end-1');
    });
    const fast = mutex.run('k', async () => {
      order.push('start-2');
      await Promise.resolve();
      order.push('end-2');
    });

    await Promise.all([slow, fast]);
    expect(order).toEqual(['start-1', 'end-1', 'start-2', 'end-2']);
  });

  it('chiavi diverse girano in parallelo', async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];

    await Promise.all([
      mutex.run('a', async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push('a');
      }),
      mutex.run('b', async () => {
        order.push('b');
        await Promise.resolve();
      }),
    ]);

    // `b` non ha aspettato `a`.
    expect(order).toEqual(['b', 'a']);
  });

  it('un task fallito non blocca il successivo', async () => {
    const mutex = new KeyedMutex();

    const failing = mutex.run('k', () => Promise.reject(new Error('boom')));
    await expect(failing).rejects.toThrow('boom');

    await expect(mutex.run('k', () => Promise.resolve('ok'))).resolves.toBe('ok');
  });

  it('non accumula chiavi in memoria', async () => {
    const mutex = new KeyedMutex();
    await mutex.run('k', () => Promise.resolve());
    expect(mutex.size).toBe(0);
  });
});

describe('promote concorrenti', () => {
  it('due promote simultanei avanzano di UN solo livello', async () => {
    await joined(MemberRank.TINY_LOC);

    await Promise.allSettled([
      h.members.promote({ discordId: USER, actorDiscordId: OG, reason: 'A' }),
      h.members.promote({ discordId: USER, actorDiscordId: OG, reason: 'B' }),
    ]);

    const member = await h.members.find(USER);
    // Tiny Loc → Loc, di UN gradino. NON deve comporsi in Tiny Loc → Loc →
    // Original Tiny Loc: è esattamente il caso che il locking impedisce.
    expect(member?.rank).toBe(MemberRank.LOC);
  });

  it('lascia comunque esattamente un rank su Discord', async () => {
    await joined(MemberRank.RESIDENT);

    await Promise.allSettled([
      h.members.promote({ discordId: USER, actorDiscordId: OG, reason: 'A' }),
      h.members.promote({ discordId: USER, actorDiscordId: OG, reason: 'B' }),
      h.members.promote({ discordId: USER, actorDiscordId: OG, reason: 'C' }),
    ]);

    const roles = h.guild.members.get(USER)?.roles;
    const rankRoles = ALL_RANK_ROLE_IDS.filter((id) => roles?.has(id));

    expect(rankRoles).toHaveLength(1);
  });

  it('il locking ottimistico rifiuta una modifica su stato obsoleto', async () => {
    await joined(MemberRank.TINY_LOC);
    const stale = await h.members.find(USER);
    if (!stale) throw new Error('membro non trovato');

    // Qualcun altro modifica per primo.
    await h.members.promote({ discordId: USER, actorDiscordId: OG, reason: 'Primo' });

    // Un update con la versione vecchia non deve passare.
    const result = await h.repos.members.updateWithVersion(stale.id, stale.version, {
      rank: MemberRank.OG,
    });
    expect(result).toBeNull();
  });
});

describe('operazioni di stato concorrenti', () => {
  it('due setInactive simultanei non duplicano nulla', async () => {
    await joined();

    const results = await Promise.all([
      h.members.setInactive({ discordId: USER, actorDiscordId: OG }),
      h.members.setInactive({ discordId: USER, actorDiscordId: OG }),
    ]);

    const changed = results.filter((r) => r.changed);
    expect(changed).toHaveLength(1);
    expect((await h.members.find(USER))?.status).toBe(MemberStatus.INACTIVE);
  });

  it('due blacklist simultanee producono una sola entry', async () => {
    addFakeMember(h.guild, USER);

    await Promise.allSettled([
      h.blacklist.add({ discordId: USER, reason: 'A', actorDiscordId: OG }),
      h.blacklist.add({ discordId: USER, reason: 'B', actorDiscordId: OG }),
    ]);

    expect(await h.blacklist.countActive()).toBe(1);
  });

  it('due candidature simultanee: una sola PENDING', async () => {
    addFakeMember(h.guild, USER);
    await verifyUser(h, USER);

    await Promise.allSettled([
      h.applications.create({ discordId: USER, username: 'a', displayName: 'A' }),
      h.applications.create({ discordId: USER, username: 'a', displayName: 'A' }),
    ]);

    expect(await h.repos.applications.countPending()).toBe(1);
  });
});

describe('compensazione dopo un errore Discord', () => {
  it('un promote fallito su Discord non lascia il database avanti', async () => {
    await joined(MemberRank.TINY_LOC);
    const before = await h.members.find(USER);

    // Da qui in poi ogni chiamata a Discord fallisce.
    h.gateway.options.failRoleUpdates = true;

    await expect(
      h.members.promote({ discordId: USER, actorDiscordId: OG, reason: 'Merito' }),
    ).rejects.toThrow();

    const after = await h.members.find(USER);
    // Il rank è tornato a quello di partenza: nessuna divergenza silenziosa.
    expect(after?.rank).toBe(before?.rank);
  });

  it('un setInactive fallito su Discord viene annullato a database', async () => {
    await joined();
    h.gateway.options.failRoleUpdates = true;

    await expect(h.members.setInactive({ discordId: USER, actorDiscordId: OG })).rejects.toThrow();

    expect((await h.members.find(USER))?.status).toBe(MemberStatus.ACTIVE);
  });

  it('un ruolo speciale fallito su Discord non resta a database', async () => {
    await joined();
    const member = await h.members.find(USER);
    if (!member) throw new Error('membro non trovato');
    h.gateway.options.failRoleUpdates = true;

    await expect(
      h.members.addSpecialRole({
        discordId: USER,
        actorDiscordId: OG,
        role: 'SHOOTER',
      }),
    ).rejects.toThrow();

    expect(await h.members.listSpecialRoles(member.id)).toHaveLength(0);
  });

  it('l’approvazione fallita non lascia una candidatura APPROVED senza membro', async () => {
    addFakeMember(h.guild, USER, { position: 1 });
    await verifyUser(h, USER);
    const application = await h.applications.create({
      discordId: USER,
      username: 'tony',
      displayName: 'Tony',
    });

    h.gateway.options.failRoleUpdates = true;

    await expect(
      h.applications.approve({ applicationId: application.id, actorDiscordId: OG }),
    ).rejects.toThrow();

    const stored = await h.applications.findById(application.id);
    expect(stored?.status).not.toBe('APPROVED');
    expect(await h.members.find(USER)).toBeNull();
  });
});

describe('audit resiliente', () => {
  it('un errore nell’invio su Discord non annulla l’operazione', async () => {
    // Il sink lancia sempre: l'operazione deve comunque completarsi.
    const { createAuditService } = await import('../../src/services/auditService.js');
    const failingSink = {
      sendAudit: () => Promise.reject(new Error('canale non raggiungibile')),
      sendMemberLog: () => Promise.reject(new Error('canale non raggiungibile')),
      sendBlacklistLog: () => Promise.reject(new Error('canale non raggiungibile')),
    };
    const audit = createAuditService({ audit: h.repos.audit, sink: failingSink });

    await expect(
      audit.record({ action: AuditAction.USER_VERIFIED, targetDiscordId: USER }),
    ).resolves.toBeUndefined();

    // Il record a database c'è comunque.
    expect(h.store.audit).toHaveLength(1);
  });
});
