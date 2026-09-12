/**
 * Superficie dei comandi e autorizzazione server-side.
 *
 * DUE PROPRIETÀ, e la seconda è ciò che rende sicura la prima.
 *
 * 1. Nessun comando dichiara `default_member_permissions`. Un gate
 *    `ManageRoles`/`ManageGuild` si frappone PRIMA della permission matrix
 *    applicativa: con quel gate attivo, assegnare a qualcuno `OG` o
 *    `Big Homie` non basterebbe — Discord rifiuterebbe l'interaction prima
 *    ancora che il bot la veda, e i due sistemi di permessi finirebbero per
 *    contraddirsi.
 *
 * 2. Di conseguenza i comandi sono VISIBILI a tutti, e l'esecuzione va
 *    rifiutata server-side a ogni singola interaction — slash command,
 *    bottoni, modal e select menu compresi. Togliere il gate senza questa
 *    seconda proprietà aprirebbe il gestionale a chiunque, quindi qui si
 *    verifica il comportamento reale del router, non solo l'assenza del gate.
 */
import { describe, expect, it } from 'vitest';
import { buildInteractionContext } from '../../src/http/interactionContext.js';
import { createHttpResponder } from '../../src/http/responder.js';
import { routeInteraction } from '../../src/http/router.js';
import { commands } from '../../src/interactions/registry.js';
import { buildCustomId } from '../../src/utils/customId.js';
import { createTestAppContext, type TestAppContext } from '../support/appContext.js';
import { addFakeMember, ROLE_IDS, verifyUser } from '../support/harness.js';
import {
  buttonInteraction,
  chatInputInteraction,
  createFakeRest,
  modalInteraction,
  selectMenuInteraction,
  TEST_ACTOR_ID,
  TEST_APPLICATION_ID,
} from '../support/discordFixtures.js';
import type { APIInteraction } from 'discord-api-types/v10';

const VICTIM = '400000000000000099';

async function dispatch(interaction: APIInteraction, test: TestAppContext): Promise<string> {
  const rest = createFakeRest();
  const responder = createHttpResponder({
    rest,
    applicationId: TEST_APPLICATION_ID,
    interactionToken: 'interaction-token',
  });

  await routeInteraction(buildInteractionContext({ interaction, responder }), test.ctx);
  responder.settle();

  const bodies: unknown[] = [
    await responder.initialResponse(),
    ...rest.requests.map((r) => r.body),
  ];
  return JSON.stringify(bodies);
}

/**
 * Contesto con un attore che ha il ruolo `OG` ma NON `TTP`.
 *
 * È lo scenario concreto contro cui la regola difende: chi riesce a farsi
 * assegnare il ruolo colorato più alto senza entrare davvero nella gang.
 */
function contextWithOgWithoutTtp(): TestAppContext {
  const test = createTestAppContext();
  addFakeMember(test.harness.guild, TEST_ACTOR_ID, {
    roles: [ROLE_IDS.verified, ROLE_IDS.og], // niente TTP
    position: 90,
  });
  addFakeMember(test.harness.guild, VICTIM, {
    roles: [ROLE_IDS.verified, ROLE_IDS.ttp, ROLE_IDS.resident],
    position: 1,
  });
  return test;
}

/** Attore con DUE rank e TTP: stato ambiguo, nessun privilegio. */
function contextWithTwoRanks(): TestAppContext {
  const test = createTestAppContext();
  addFakeMember(test.harness.guild, TEST_ACTOR_ID, {
    roles: [ROLE_IDS.verified, ROLE_IDS.ttp, ROLE_IDS.resident, ROLE_IDS.og],
    position: 90,
  });
  addFakeMember(test.harness.guild, VICTIM, {
    roles: [ROLE_IDS.verified, ROLE_IDS.ttp, ROLE_IDS.resident],
    position: 1,
  });
  return test;
}

describe('nessun gate Discord davanti alla permission matrix', () => {
  it('nessun comando dichiara default_member_permissions', () => {
    const gated = commands
      .filter((command) => {
        const data = command.data as { default_member_permissions?: string | null };
        return (
          data.default_member_permissions !== undefined && data.default_member_permissions !== null
        );
      })
      .map((command) => command.name);

    expect(gated).toEqual([]);
  });

  it('i comandi amministrativi esistono comunque nel registro', () => {
    // Rimuovere il gate non deve aver rimosso il comando.
    const names = commands.map((command) => command.name);
    expect(names).toEqual(
      expect.arrayContaining(['member', 'community', 'blacklist', 'panel', 'system', 'setup']),
    );
  });
});

describe('un rank senza TTP viene rifiutato dagli slash command', () => {
  it.each([
    [
      '/member add',
      chatInputInteraction('member', {
        subcommand: 'add',
        users: { user: { id: VICTIM, username: 'vittima' } },
      }),
    ],
    [
      '/member remove',
      chatInputInteraction('member', {
        subcommand: 'remove',
        users: { user: { id: VICTIM, username: 'vittima' } },
        strings: { reason: 'motivo qualunque' },
      }),
    ],
    [
      '/blacklist add',
      chatInputInteraction('blacklist', {
        subcommand: 'add',
        users: { user: { id: VICTIM, username: 'vittima' } },
        strings: { reason: 'motivo qualunque' },
      }),
    ],
    ['/panel', chatInputInteraction('panel')],
    ['/system sync-check', chatInputInteraction('system', { subcommand: 'sync-check' })],
    ['/setup', chatInputInteraction('setup', { subcommand: 'check' })],
  ])('%s', async (_name, interaction) => {
    const test = contextWithOgWithoutTtp();
    const text = await dispatch(interaction, test);

    // Il messaggio d'errore nomina TTP: il diniego è quello giusto, non un
    // fallimento accidentale che passerebbe comunque questo test.
    expect(text).toContain('TTP');
    // E nessuna scrittura è avvenuta.
    expect(await test.harness.repos.members.findByDiscordId(VICTIM)).toBeNull();
  });

  it('lascia passare la sola lettura', async () => {
    const test = contextWithOgWithoutTtp();
    const text = await dispatch(chatInputInteraction('roster'), test);
    expect(text).toContain('ROSTER');
  });
});

describe('due rank contemporaneamente vengono rifiutati', () => {
  it('/member add non viene eseguito', async () => {
    const test = contextWithTwoRanks();
    const text = await dispatch(
      chatInputInteraction('member', {
        subcommand: 'add',
        users: { user: { id: VICTIM, username: 'vittima' } },
      }),
      test,
    );

    expect(text).toContain('rank');
    expect(await test.harness.repos.members.findByDiscordId(VICTIM)).toBeNull();
  });

  it('/system sync-check non viene eseguito', async () => {
    const test = contextWithTwoRanks();
    const text = await dispatch(chatInputInteraction('system', { subcommand: 'sync-check' }), test);
    expect(text).not.toContain('DATA INTEGRITY');
  });
});

describe('bottoni, modal e select rivalutano i permessi a ogni interaction', () => {
  // Che un pannello sia stato creato da un OG non dice NULLA su chi ci sta
  // cliccando adesso: il customId è solo un'etichetta, non una prova.

  it('il bottone di promozione di una member card', async () => {
    const test = contextWithOgWithoutTtp();
    const text = await dispatch(
      buttonInteraction(buildCustomId('member', 'promote', VICTIM)),
      test,
    );
    expect(text).toContain('TTP');
  });

  it('il bottone del control panel', async () => {
    const test = contextWithOgWithoutTtp();
    const text = await dispatch(buttonInteraction(buildCustomId('panel', 'stats')), test);
    expect(text).toContain('TTP');
  });

  it('il select menu dei ruoli speciali', async () => {
    const test = contextWithOgWithoutTtp();
    const text = await dispatch(
      selectMenuInteraction(buildCustomId('member', 'rolesSelect', VICTIM), ['SHOOTER']),
      test,
    );

    expect(text).toContain('TTP');
    const member = await test.harness.repos.members.findByDiscordId(VICTIM);
    expect(member).toBeNull();
  });

  it('il modal delle note della Leadership', async () => {
    const test = contextWithOgWithoutTtp();
    const text = await dispatch(
      modalInteraction(buildCustomId('member', 'notesSubmit', VICTIM), { notes: 'nota segreta' }),
      test,
    );
    expect(text).toContain('TTP');
  });

  it('un attore con TTP e un solo rank valido invece passa', async () => {
    // Il contronesempio: senza questo, i test sopra passerebbero anche se il
    // router rifiutasse tutto per un motivo qualsiasi.
    const test = createTestAppContext();
    addFakeMember(test.harness.guild, TEST_ACTOR_ID, {
      roles: [ROLE_IDS.verified, ROLE_IDS.ttp, ROLE_IDS.og],
      position: 90,
    });
    addFakeMember(test.harness.guild, VICTIM, { position: 1 });
    await verifyUser(test.harness, VICTIM);

    const text = await dispatch(
      chatInputInteraction('member', {
        subcommand: 'add',
        users: { user: { id: VICTIM, username: 'vittima' } },
      }),
      test,
    );

    expect(text).not.toContain('senza membership');
    expect(await test.harness.repos.members.findByDiscordId(VICTIM)).not.toBeNull();
  });
});

describe('la gerarchia Discord reale resta comunque applicata', () => {
  it('un OG regolare non amministra chi gli sta sopra in gerarchia', async () => {
    const test = createTestAppContext();
    addFakeMember(test.harness.guild, TEST_ACTOR_ID, {
      roles: [ROLE_IDS.verified, ROLE_IDS.ttp, ROLE_IDS.og],
      position: 5,
    });
    addFakeMember(test.harness.guild, VICTIM, {
      roles: [ROLE_IDS.verified, ROLE_IDS.ttp, ROLE_IDS.resident],
      position: 99, // ruolo Discord più alto dell'attore
    });
    await verifyUser(test.harness, VICTIM);

    const text = await dispatch(
      chatInputInteraction('member', {
        subcommand: 'add',
        users: { user: { id: VICTIM, username: 'vittima' } },
      }),
      test,
    );

    expect(text).toContain('gerarchia Discord');
    expect(await test.harness.repos.members.findByDiscordId(VICTIM)).toBeNull();
  });
});
