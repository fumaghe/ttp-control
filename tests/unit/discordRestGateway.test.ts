/**
 * DiscordRestGateway: l'adapter che sostituisce la cache della guild di
 * discord.js.
 *
 * Di un adapter conta una cosa sola: quali richieste manda davvero a Discord.
 * Questi test la verificano contro un client REST finto.
 */
import { describe, expect, it } from 'vitest';
import { createDiscordRestGateway } from '../../src/discord/gateway.js';
import {
  computeChannelPermissions,
  computeGuildPermissions,
  hasPermission,
  PERMISSION,
} from '../../src/discord/api.js';
import { createDiscordRest } from '../../src/discord/rest.js';
import { AppError } from '../../src/errors/AppError.js';
import { createFakeRest } from '../support/discordFixtures.js';

const GUILD_ID = '100000000000000001';
const APP_ID = '100000000000000003';
const MEMBER_ID = '400000000000000001';

const ROLES = [
  { id: GUILD_ID, name: '@everyone', position: 0, permissions: '0', managed: false },
  { id: '200000000000000010', name: 'Bot', position: 50, permissions: '268435456', managed: false },
  { id: '200000000000000001', name: 'Verified', position: 10, permissions: '0', managed: false },
  { id: '200000000000000002', name: 'TTP', position: 20, permissions: '0', managed: false },
  { id: '200000000000000099', name: 'Admin', position: 90, permissions: '8', managed: false },
  { id: '200000000000000098', name: 'Booster', position: 15, permissions: '0', managed: true },
];

function baseRoutes(memberRoles: string[] = ['200000000000000001']) {
  return {
    [`GET /guilds/${GUILD_ID}`]: { id: GUILD_ID, name: 'TTP', owner_id: '999999999999999999' },
    [`GET /guilds/${GUILD_ID}/roles`]: ROLES,
    [`GET /guilds/${GUILD_ID}/members/${APP_ID}`]: {
      user: { id: APP_ID, username: 'ttp-control' },
      roles: ['200000000000000010'],
    },
    [`GET /guilds/${GUILD_ID}/members/${MEMBER_ID}`]: {
      user: { id: MEMBER_ID, username: 'tony', global_name: 'Tony Montana' },
      nick: 'Tony',
      roles: memberRoles,
    },
    [`PATCH /guilds/${GUILD_ID}/members/${MEMBER_ID}`]: (body: unknown) => ({
      user: { id: MEMBER_ID, username: 'tony' },
      nick: 'Tony',
      roles: (body as { roles: string[] }).roles,
    }),
  };
}

/** Risposta plausibile per una URL dell'API, usata con un fetch finto. */
function routeFor(url: string): unknown {
  if (url.endsWith('/roles')) return ROLES;
  if (url.endsWith(`/guilds/${GUILD_ID}`)) {
    return { id: GUILD_ID, name: 'TTP', owner_id: '999999999999999999' };
  }
  return { user: { id: APP_ID, username: 'ttp-control' }, roles: ['200000000000000010'] };
}

function build(routes: Record<string, unknown> = baseRoutes()) {
  const rest = createFakeRest(routes);
  const gateway = createDiscordRestGateway({
    rest,
    guildId: GUILD_ID,
    applicationId: APP_ID,
  });
  return { rest, gateway };
}

describe('lettura dei membri', () => {
  it('costruisce lo snapshot con display name e posizione più alta', async () => {
    const { gateway } = build(baseRoutes(['200000000000000001', '200000000000000002']));
    const snapshot = await gateway.getMember(MEMBER_ID);

    expect(snapshot?.discordId).toBe(MEMBER_ID);
    expect(snapshot?.displayName).toBe('Tony');
    expect(snapshot?.highestRolePosition).toBe(20);
    expect(snapshot?.isGuildOwner).toBe(false);
  });

  it('restituisce null se il membro non è più nella guild', async () => {
    // Percorso reale: client REST vero, risposta 404 di Discord.
    const rest = createDiscordRest({
      token: 'bot-token',
      fetchImpl: ((url: string) =>
        Promise.resolve(
          url.includes(`/members/${MEMBER_ID}`)
            ? new Response(JSON.stringify({ code: 10007, message: 'Unknown Member' }), {
                status: 404,
              })
            : new Response(JSON.stringify(routeFor(url)), { status: 200 }),
        )) as unknown as typeof fetch,
    });

    const gateway = createDiscordRestGateway({ rest, guildId: GUILD_ID, applicationId: APP_ID });
    await expect(gateway.getMember(MEMBER_ID)).resolves.toBeNull();
  });

  it('riusa le stesse GET dentro una singola invocazione', async () => {
    // Su Workers ogni interaction riparte da zero: senza questa cache un
    // `/setup check` farebbe decine di richieste identiche.
    const { rest, gateway } = build();
    await gateway.getRoles();
    await gateway.getRoles();
    await gateway.getGuild();
    await gateway.getGuild();

    const roleCalls = rest.requests.filter((r) => r.path.endsWith('/roles'));
    const guildCalls = rest.requests.filter((r) => r.path === `/guilds/${GUILD_ID}`);
    expect(roleCalls).toHaveLength(1);
    expect(guildCalls).toHaveLength(1);
  });
});

describe('enumerazione paginata', () => {
  it('scorre le pagine finché Discord ne restituisce di piene', async () => {
    const page = (start: number, count: number): unknown[] =>
      Array.from({ length: count }, (_, index) => ({
        user: { id: String(500000000000000000n + BigInt(start + index)), username: `u${index}` },
        roles: [],
      }));

    const rest = createFakeRest(baseRoutes());
    let call = 0;
    rest.routes.set(`GET /guilds/${GUILD_ID}/members`, () => {
      call += 1;
      // Prima pagina piena (1000), seconda parziale: la paginazione si ferma.
      return call === 1 ? page(0, 1000) : page(1000, 7);
    });

    const gateway = createDiscordRestGateway({
      rest,
      guildId: GUILD_ID,
      applicationId: APP_ID,
    });

    const members = await gateway.listMembers();
    expect(members).toHaveLength(1007);
    expect(call).toBe(2);
  });

  it('filtra per ruolo senza chiedere a Discord un endpoint che non esiste', async () => {
    const rest = createFakeRest(baseRoutes());
    rest.routes.set(`GET /guilds/${GUILD_ID}/members`, () => [
      { user: { id: '500000000000000001', username: 'a' }, roles: ['200000000000000001'] },
      { user: { id: '500000000000000002', username: 'b' }, roles: [] },
    ]);

    const gateway = createDiscordRestGateway({
      rest,
      guildId: GUILD_ID,
      applicationId: APP_ID,
    });

    const holders = await gateway.listMembersWithAnyRole(['200000000000000001']);
    expect(holders.map((member) => member.discordId)).toEqual(['500000000000000001']);
  });
});

describe('applyRoleDiff', () => {
  it('applica il diff con una sola PATCH contenente l’insieme finale', async () => {
    // Una sola chiamata: mai uno stato intermedio in cui il membro ha zero
    // rank o due, e un solo rate limit consumato.
    const { rest, gateway } = build(baseRoutes(['200000000000000001']));

    await gateway.applyRoleDiff(
      MEMBER_ID,
      { add: ['200000000000000002'], remove: ['200000000000000001'] },
      'test',
    );

    const patches = rest.requests.filter((request) => request.method === 'PATCH');
    expect(patches).toHaveLength(1);
    expect(patches[0]?.body).toEqual({ roles: ['200000000000000002'] });
    expect(patches[0]?.reason).toBe('test');
  });

  it('non chiama Discord se il diff non cambia nulla', async () => {
    const { rest, gateway } = build(baseRoutes(['200000000000000001']));
    await gateway.applyRoleDiff(MEMBER_ID, { add: ['200000000000000001'] }, 'no-op');

    expect(rest.requests.filter((request) => request.method === 'PATCH')).toHaveLength(0);
  });

  it('rifiuta i ruoli sopra la posizione del bot con un errore leggibile', async () => {
    const { gateway } = build(baseRoutes(['200000000000000001']));

    await expect(
      gateway.applyRoleDiff(MEMBER_ID, { add: ['200000000000000099'] }, 'test'),
    ).rejects.toMatchObject({ code: 'ROLE_HIERARCHY' });
  });

  it('rifiuta i ruoli managed, che Discord non lascia assegnare a nessuno', async () => {
    const { gateway } = build(baseRoutes(['200000000000000001']));

    await expect(
      gateway.applyRoleDiff(MEMBER_ID, { add: ['200000000000000098'] }, 'test'),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('non pretende di poter gestire un ruolo che sta solo rimuovendo a vuoto', async () => {
    // Rimuovere un ruolo che il membro non ha è un no-op: non deve far
    // fallire l'operazione per un problema di gerarchia inesistente.
    const { gateway } = build(baseRoutes(['200000000000000001']));

    await expect(
      gateway.applyRoleDiff(
        MEMBER_ID,
        { add: ['200000000000000002'], remove: ['200000000000000099'] },
        'test',
      ),
    ).resolves.toBeDefined();
  });

  it('segnala che il bersaglio ha lasciato la guild', async () => {
    const rest = createFakeRest(baseRoutes());
    rest.routes.set(`GET /guilds/${GUILD_ID}/members/${MEMBER_ID}`, () => undefined);

    const gateway = createDiscordRestGateway({
      rest,
      guildId: GUILD_ID,
      applicationId: APP_ID,
    });

    await expect(
      gateway.applyRoleDiff(MEMBER_ID, { add: ['200000000000000002'] }, 'test'),
    ).rejects.toMatchObject({ code: 'TARGET_LEFT_GUILD' });
  });
});

describe('messaggi', () => {
  it('invia un messaggio senza mai pingare le menzioni', async () => {
    // Gli embed di audit contengono `<@id>` per essere leggibili, non per
    // svegliare mezzo server.
    const { rest, gateway } = build({
      ...baseRoutes(),
      'POST /channels/300000000000000005/messages': { id: '950000000000000001' },
    });

    const id = await gateway.sendMessage('300000000000000005', { content: 'ciao <@1>' });

    expect(id).toBe('950000000000000001');
    expect(rest.requests.at(-1)?.body).toMatchObject({ allowed_mentions: { parse: [] } });
  });

  it('la modifica azzera esplicitamente embed e componenti', async () => {
    // Omettere `components` in una PATCH lascerebbe attaccati i bottoni
    // vecchi: nella paginazione del roster significa controlli che puntano
    // alla pagina sbagliata.
    const { rest, gateway } = build({
      ...baseRoutes(),
      'PATCH /channels/300000000000000005/messages/950000000000000001': {},
    });

    await gateway.editMessage('300000000000000005', '950000000000000001', { content: 'nuovo' });

    expect(rest.requests.at(-1)?.body).toEqual({
      content: 'nuovo',
      embeds: [],
      components: [],
      allowed_mentions: { parse: [] },
    });
  });

  it('sendDM apre il canale privato prima di scrivere', async () => {
    const { rest, gateway } = build({
      ...baseRoutes(),
      'POST /users/@me/channels': { id: '600000000000000001', type: 1 },
      'POST /channels/600000000000000001/messages': { id: '950000000000000002' },
    });

    expect(await gateway.sendDM(MEMBER_ID, { content: 'ciao' })).toBe(true);
    expect(rest.requests.map((request) => request.path)).toContain('/users/@me/channels');
  });
});

describe('moderazione', () => {
  it('kick usa DELETE sul membro, ban usa PUT sulla lista ban', async () => {
    const { rest, gateway } = build(baseRoutes());

    await gateway.kick(MEMBER_ID, 'motivo');
    await gateway.ban(MEMBER_ID, 'motivo');

    const paths = rest.requests.map((request) => `${request.method} ${request.path}`);
    expect(paths).toContain(`DELETE /guilds/${GUILD_ID}/members/${MEMBER_ID}`);
    expect(paths).toContain(`PUT /guilds/${GUILD_ID}/bans/${MEMBER_ID}`);
  });
});

describe('calcolo dei permessi', () => {
  it('somma i permessi dei ruoli e di @everyone', () => {
    const bits = computeGuildPermissions(GUILD_ID, ROLES, ['200000000000000010'], false);
    expect(hasPermission(bits, PERMISSION.MANAGE_ROLES)).toBe(true);
    expect(hasPermission(bits, PERMISSION.MANAGE_NICKNAMES)).toBe(false);
  });

  it('Administrator implica ogni permesso', () => {
    const bits = computeGuildPermissions(GUILD_ID, ROLES, ['200000000000000099'], false);
    expect(hasPermission(bits, PERMISSION.MANAGE_NICKNAMES)).toBe(true);
  });

  it('il proprietario della guild ha sempre tutto', () => {
    const bits = computeGuildPermissions(GUILD_ID, ROLES, [], true);
    expect(hasPermission(bits, PERMISSION.SEND_MESSAGES)).toBe(true);
  });

  it('gli overwrite di canale seguono l’ordine di Discord', () => {
    // @everyone nega, un ruolo posseduto riconcede: l'allow del ruolo vince.
    const channel = {
      id: '300000000000000005',
      type: 0,
      permission_overwrites: [
        { id: GUILD_ID, type: 0 as const, allow: '0', deny: String(PERMISSION.VIEW_CHANNEL) },
        {
          id: '200000000000000010',
          type: 0 as const,
          allow: String(PERMISSION.VIEW_CHANNEL),
          deny: '0',
        },
      ],
    };

    const base = PERMISSION.VIEW_CHANNEL | PERMISSION.SEND_MESSAGES;
    const bits = computeChannelPermissions(GUILD_ID, channel, base, APP_ID, ['200000000000000010']);

    expect(hasPermission(bits, PERMISSION.VIEW_CHANNEL)).toBe(true);
  });

  it('un deny sul singolo membro vince su tutto il resto', () => {
    const channel = {
      id: '300000000000000005',
      type: 0,
      permission_overwrites: [
        {
          id: '200000000000000010',
          type: 0 as const,
          allow: String(PERMISSION.SEND_MESSAGES),
          deny: '0',
        },
        { id: APP_ID, type: 1 as const, allow: '0', deny: String(PERMISSION.SEND_MESSAGES) },
      ],
    };

    const bits = computeChannelPermissions(GUILD_ID, channel, PERMISSION.SEND_MESSAGES, APP_ID, [
      '200000000000000010',
    ]);

    expect(hasPermission(bits, PERMISSION.SEND_MESSAGES)).toBe(false);
  });
});
