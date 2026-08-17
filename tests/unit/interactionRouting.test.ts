/**
 * Livello HTTP: responder e routing delle interaction.
 *
 * Il punto critico è il vincolo dei 3 secondi di Discord: la prima risposta
 * è il corpo HTTP della richiesta stessa. Questi test verificano che venga
 * sempre prodotta, e che sia quella giusta per ogni tipo di interaction.
 */
import { describe, expect, it } from 'vitest';
import { InteractionResponseType, InteractionType } from 'discord-api-types/v10';
import { buildInteractionContext } from '../../src/http/interactionContext.js';
import { createHttpResponder } from '../../src/http/responder.js';
import { routeInteraction } from '../../src/http/router.js';
import { createTestAppContext } from '../support/appContext.js';
import { addFakeMember, ROLE_IDS, verifyUser } from '../support/harness.js';
import {
  autocompleteInteraction,
  buttonInteraction,
  chatInputInteraction,
  createFakeRest,
  modalInteraction,
  selectMenuInteraction,
  TEST_ACTOR_ID,
  TEST_APPLICATION_ID,
} from '../support/discordFixtures.js';
import type { APIInteraction } from 'discord-api-types/v10';

function harnessResponder(rest = createFakeRest()) {
  return {
    rest,
    responder: createHttpResponder({
      rest,
      applicationId: TEST_APPLICATION_ID,
      interactionToken: 'interaction-token',
    }),
  };
}

/* -------------------------------------------------------------------------- */
/* Responder                                                                   */
/* -------------------------------------------------------------------------- */

describe('responder', () => {
  it('una risposta immediata diventa il corpo HTTP dell’interaction', async () => {
    const { responder } = harnessResponder();
    await responder.send({ content: 'fatto' });

    const initial = await responder.initialResponse();
    expect(initial.type).toBe(InteractionResponseType.ChannelMessageWithSource);
    expect(initial).toMatchObject({ data: { content: 'fatto' } });
  });

  it('defer produce DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE ephemeral', async () => {
    const { responder } = harnessResponder();
    await responder.defer();

    const initial = await responder.initialResponse();
    expect(initial.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource);
    // 64 = MessageFlags.Ephemeral: le risposte amministrative restano private.
    expect(initial).toMatchObject({ data: { flags: 64 } });
  });

  it('dopo un defer la risposta va in PATCH sul messaggio originale', async () => {
    const { rest, responder } = harnessResponder();
    await responder.defer();
    await responder.send({ content: 'risultato' });

    const patch = rest.requests.find((request) => request.method === 'PATCH');
    expect(patch?.path).toBe(
      `/webhooks/${TEST_APPLICATION_ID}/interaction-token/messages/@original`,
    );
    // Gli endpoint webhook sono autenticati dal token dell'interaction, non
    // dal bot token: mandare quest'ultimo sarebbe un leak inutile.
    expect(patch?.auth).toBe(false);
  });

  it('una seconda risposta dopo l’edit diventa un follow-up', async () => {
    const { rest, responder } = harnessResponder();
    await responder.defer();
    await responder.send({ content: 'primo' });
    await responder.send({ content: 'secondo' });

    const posts = rest.requests.filter((request) => request.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.path).toBe(`/webhooks/${TEST_APPLICATION_ID}/interaction-token`);
  });

  it('showModal è la risposta iniziale e non richiede defer', async () => {
    const { rest, responder } = harnessResponder();
    await responder.showModal({ custom_id: 'verify:submit', title: 'Verifica', components: [] });

    const initial = await responder.initialResponse();
    expect(initial.type).toBe(InteractionResponseType.Modal);
    // Un modal non passa mai dagli endpoint webhook.
    expect(rest.requests).toHaveLength(0);
  });

  it('un modal richiesto dopo un defer viene ignorato invece di rompere', async () => {
    const { responder } = harnessResponder();
    await responder.defer();
    await responder.showModal({ custom_id: 'x:y', title: 'T', components: [] });

    const initial = await responder.initialResponse();
    expect(initial.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource);
  });

  it('autocomplete risponde con le scelte', async () => {
    const { responder } = harnessResponder();
    await responder.autocomplete([{ name: 'Tony', value: 'tony' }]);

    const initial = await responder.initialResponse();
    expect(initial.type).toBe(InteractionResponseType.ApplicationCommandAutocompleteResult);
  });

  it('settle produce comunque un corpo valido se nessuno ha risposto', async () => {
    // Senza questo, un handler che fallisce prima di rispondere lascerebbe
    // Discord senza risposta e l'utente davanti a "L'applicazione non ha
    // risposto".
    const { responder } = harnessResponder();
    responder.settle();

    const initial = await responder.initialResponse();
    expect(initial.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource);
  });

  it('risponde da sé con un deferred se l’handler supera il margine dei 3s', async () => {
    const rest = createFakeRest();
    const responder = createHttpResponder({
      rest,
      applicationId: TEST_APPLICATION_ID,
      interactionToken: 'interaction-token',
      autoDeferMs: 5,
    });

    const initial = await responder.initialResponse();
    expect(initial.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource);

    // E il risultato tardivo raggiunge comunque l'utente, via PATCH.
    await responder.send({ content: 'in ritardo ma arrivato' });
    expect(rest.requests.some((request) => request.method === 'PATCH')).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Routing                                                                     */
/* -------------------------------------------------------------------------- */

async function dispatch(
  interaction: APIInteraction,
  test = createTestAppContext(),
): Promise<{
  initial: Awaited<ReturnType<ReturnType<typeof createHttpResponder>['initialResponse']>>;
  rest: ReturnType<typeof createFakeRest>;
  test: ReturnType<typeof createTestAppContext>;
}> {
  const { rest, responder } = harnessResponder();
  const ictx = buildInteractionContext({ interaction, responder });

  await routeInteraction(ictx, test.ctx);
  responder.settle();

  return { initial: await responder.initialResponse(), rest, test };
}

/** Il testo di tutte le risposte prodotte, iniziale e webhook. */
function textOf(result: Awaited<ReturnType<typeof dispatch>>): string {
  const bodies: unknown[] = [result.initial, ...result.rest.requests.map((r) => r.body)];
  return JSON.stringify(bodies);
}

describe('routing degli slash command', () => {
  it('instrada /roster e risponde', async () => {
    const test = createTestAppContext();
    addFakeMember(test.harness.guild, TEST_ACTOR_ID, {
      roles: [ROLE_IDS.verified, ROLE_IDS.ttp, ROLE_IDS.og],
      position: 10,
    });

    const result = await dispatch(chatInputInteraction('roster'), test);

    expect(result.initial.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource);
    expect(textOf(result)).toContain('ROSTER');
  });

  it('legge le opzioni annidate sotto un subcommand', async () => {
    const test = createTestAppContext();
    await verifyUser(test.harness, TEST_ACTOR_ID);

    const result = await dispatch(
      chatInputInteraction('apply', {
        subcommand: 'ttp',
        strings: { messaggio: 'Vorrei entrare nella gang' },
      }),
      test,
    );

    // La candidatura è stata creata davvero: le opzioni sono state lette.
    const pending = await test.harness.repos.applications.findPendingByDiscordId(TEST_ACTOR_ID);
    expect(pending).not.toBeNull();
    expect(pending?.notes).toBe('Vorrei entrare nella gang');
    expect(textOf(result)).toContain('Candidatura inviata');
  });

  it('un comando sconosciuto riceve una risposta, non silenzio', async () => {
    const result = await dispatch(chatInputInteraction('inesistente'));
    expect(textOf(result)).toContain('Comando non riconosciuto');
  });

  it('rifiuta le interaction provenienti da un’altra guild', async () => {
    // L'app potrebbe essere invitata altrove: la configurazione di questo
    // server non deve essere applicata a un server estraneo.
    const interaction = {
      ...chatInputInteraction('roster'),
      guild_id: '111111111111111111',
    } as APIInteraction;

    const result = await dispatch(interaction);
    expect(textOf(result)).toContain('configurato per un altro server');
  });
});

describe('routing dei componenti', () => {
  it('instrada il click sul bottone di verifica aprendo il modal', async () => {
    const result = await dispatch(buttonInteraction('verify:start'));
    expect(result.initial.type).toBe(InteractionResponseType.Modal);
  });

  it('rifiuta un customId malformato senza interpretarlo', async () => {
    // Arriva da un client manipolato: non deve mai raggiungere un handler.
    const result = await dispatch(buttonInteraction('namespace-inventato'));
    expect(textOf(result)).toContain('non è più valida');
  });

  it('rifiuta un customId con un namespace sconosciuto', async () => {
    const result = await dispatch(buttonInteraction('sconosciuto:azione'));
    expect(textOf(result)).toContain('non è più valida');
  });

  it('instrada una select menu leggendone i valori', async () => {
    const test = createTestAppContext();
    const targetId = '400000000000000009';

    addFakeMember(test.harness.guild, TEST_ACTOR_ID, {
      roles: [ROLE_IDS.verified, ROLE_IDS.ttp, ROLE_IDS.og],
      position: 10,
    });
    addFakeMember(test.harness.guild, targetId, { position: 1 });
    // La verifica precede sempre la membership: `TTP ⇒ Verified`.
    await verifyUser(test.harness, targetId);
    await test.harness.members.addToGang({
      discordId: targetId,
      actorDiscordId: TEST_ACTOR_ID,
      rank: 'RESIDENT',
      reason: 'setup del test',
      source: 'manual',
    });

    const result = await dispatch(
      selectMenuInteraction(`member:rolesSelect:${targetId}`, ['SHOOTER']),
      test,
    );

    expect(textOf(result)).toContain('Shooter');
  });
});

describe('routing dei modal', () => {
  it('instrada il submit di verifica e legge i campi del form', async () => {
    const test = createTestAppContext();
    addFakeMember(test.harness.guild, TEST_ACTOR_ID);

    const result = await dispatch(
      modalInteraction('verify:submit', {
        rpName: 'Tony',
        rpSurname: 'Montana',
        citizenId: '8712',
        phone: '555-1234',
        referral: 'Conosciuto in strada',
      }),
      test,
    );

    expect(textOf(result)).toContain('VERIFICA COMPLETATA');

    const verification = await test.harness.repos.verifications.findActive(TEST_ACTOR_ID);
    expect(verification?.rpName).toBe('Tony');

    // Verified sì, TTP no: è l'invariante centrale del progetto.
    const member = test.harness.guild.members.get(TEST_ACTOR_ID);
    expect(member?.roles.has(ROLE_IDS.verified)).toBe(true);
    expect(member?.roles.has(ROLE_IDS.ttp)).toBe(false);
  });

  it('un errore di validazione diventa una risposta, non un’eccezione', async () => {
    const test = createTestAppContext();
    addFakeMember(test.harness.guild, TEST_ACTOR_ID);

    const result = await dispatch(
      modalInteraction('verify:submit', {
        rpName: 'T',
        rpSurname: '',
        citizenId: '',
        phone: '',
        referral: '',
      }),
      test,
    );

    expect(textOf(result)).toContain('Operazione non completata');
  });
});

describe('routing dell’autocomplete', () => {
  it('risponde con un elenco vuoto se il comando non lo implementa', async () => {
    const { rest, responder } = harnessResponder();
    const ictx = buildInteractionContext({
      interaction: autocompleteInteraction('roster', 'ton'),
      responder,
    });

    await routeInteraction(ictx, createTestAppContext().ctx);
    const initial = await responder.initialResponse();

    expect(initial.type).toBe(InteractionResponseType.ApplicationCommandAutocompleteResult);
    expect(initial).toMatchObject({ data: { choices: [] } });
    expect(rest.requests).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Parsing del contesto                                                        */
/* -------------------------------------------------------------------------- */

describe('InteractionContext', () => {
  it('espone attore, guild, canale e token senza tipi di libreria', () => {
    const { responder } = harnessResponder();
    const ictx = buildInteractionContext({
      interaction: chatInputInteraction('ping'),
      responder,
    });

    expect(ictx.actorDiscordId).toBe(TEST_ACTOR_ID);
    expect(ictx.user.displayName).toBe('Tony');
    expect(ictx.memberRoleIds).toEqual([ROLE_IDS.ttp]);
    expect(ictx.guildId).toBe('100000000000000001');
    expect(ictx.interactionToken).toBe('interaction-token');
    expect(ictx.type).toBe(InteractionType.ApplicationCommand);
  });

  it('risolve le opzioni utente dai dati risolti', () => {
    const { responder } = harnessResponder();
    const ictx = buildInteractionContext({
      interaction: chatInputInteraction('member', {
        subcommand: 'info',
        users: { user: { id: '400000000000000002', username: 'sosa', nick: 'Alejandro' } },
      }),
      responder,
    });

    expect(ictx.options.getSubcommand(true)).toBe('info');
    const user = ictx.options.getUser('user', true);
    expect(user.id).toBe('400000000000000002');
    expect(user.displayName).toBe('Alejandro');
  });

  it('legge i campi di un modal annidati nei componenti label', () => {
    const { responder } = harnessResponder();
    const ictx = buildInteractionContext({
      interaction: modalInteraction('member:notesSubmit:400000000000000002', {
        notes: 'Affidabile',
      }),
      responder,
    });

    expect(ictx.fields.getTextInputValue('notes')).toBe('Affidabile');
    expect(ictx.fields.getTextInputValue('inesistente')).toBe('');
    expect(ictx.customId).toBe('member:notesSubmit:400000000000000002');
  });

  it('espone i valori di una select e il tipo di componente', () => {
    const { responder } = harnessResponder();
    const ictx = buildInteractionContext({
      interaction: selectMenuInteraction('member:rolesSelect:400000000000000002', [
        'SHOOTER',
        'HONOR_1',
      ]),
      responder,
    });

    expect(ictx.isStringSelectMenu()).toBe(true);
    expect(ictx.isButton()).toBe(false);
    expect(ictx.values).toEqual(['SHOOTER', 'HONOR_1']);
  });

  it('espone l’opzione con il focus in un autocomplete', () => {
    const { responder } = harnessResponder();
    const ictx = buildInteractionContext({
      interaction: autocompleteInteraction('roster', 'ton'),
      responder,
    });

    expect(ictx.options.getFocused()).toEqual({ name: 'query', value: 'ton' });
  });
});
