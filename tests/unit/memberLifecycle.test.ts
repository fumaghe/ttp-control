/**
 * Messaggi automatici di benvenuto e addio.
 *
 * Tre livelli, testati separatamente perché falliscono per ragioni diverse:
 *  - l'URL dell'avatar (regole del CDN Discord);
 *  - gli embed (testo e forma, senza rete);
 *  - il service (su quale canale finisce cosa, e cosa NON deve essere inviato).
 */
import { describe, expect, it, vi } from 'vitest';
import type { APIEmbed } from 'discord-api-types/v10';
import {
  buildGoodbyeMessage,
  buildWelcomeMessage,
} from '../../src/components/embeds/memberLifecycle.js';
import { GANG_NAME } from '../../src/config/constants.js';
import { GOODBYE_PHRASES, WELCOME_PHRASES } from '../../src/config/lifecyclePhrases.js';
import type { ApiUser } from '../../src/discord/api.js';
import { avatarUrl, defaultAvatarIndex, defaultAvatarUrl } from '../../src/discord/avatar.js';
import type { MessagePayload } from '../../src/discord/payload.js';
import {
  createMemberLifecycleMessageService,
  type LifecycleMessageGateway,
} from '../../src/services/memberLifecycleMessageService.js';
import { pickRandom } from '../../src/utils/random.js';

const USER_ID = '500000000000000001';
const WELCOME_CHANNEL = '300000000000000008';
const GOODBYE_CHANNEL = '300000000000000009';

interface Sent {
  channelId: string;
  payload: MessagePayload;
}

function embedOf(payload: MessagePayload | undefined): APIEmbed {
  const first = payload?.embeds?.[0];
  if (!first) throw new Error('payload senza embed');
  return 'toJSON' in first ? first.toJSON() : first;
}

/** L'embed dell'n-esimo messaggio inviato. Fallisce se non c'è. */
function embedOfSent(sent: readonly Sent[], index = 0): APIEmbed {
  return embedOf(sent[index]?.payload);
}

// -----------------------------------------------------------------------------
// Avatar
// -----------------------------------------------------------------------------

describe('URL dell’avatar Discord', () => {
  it('usa il CDN ufficiale per un avatar custom', () => {
    const url = avatarUrl({ id: USER_ID, avatar: 'abc123' });

    expect(url).toBe(`https://cdn.discordapp.com/avatars/${USER_ID}/abc123.png?size=1024`);
  });

  it('serve in GIF gli avatar animati (hash con prefisso a_)', () => {
    // Chiedere un avatar animato in PNG restituisce un fermo immagine.
    const url = avatarUrl({ id: USER_ID, avatar: 'a_deadbeef' });

    expect(url).toBe(`https://cdn.discordapp.com/avatars/${USER_ID}/a_deadbeef.gif?size=1024`);
    expect(url).not.toContain('.png');
  });

  it('ricade sull’avatar di default quando l’hash è null', () => {
    const url = avatarUrl({ id: USER_ID, avatar: null });

    expect(url).toMatch(/^https:\/\/cdn\.discordapp\.com\/embed\/avatars\/[0-5]\.png$/);
  });

  it('tratta un hash assente come avatar di default', () => {
    expect(avatarUrl({ id: USER_ID })).toBe(defaultAvatarUrl({ id: USER_ID }));
  });

  it('deriva l’indice di default dallo snowflake sugli account migrati', () => {
    // Regola corrente: (id >> 22) % 6. Con discriminator "0" è l'unica valida.
    const expected = Number((BigInt(USER_ID) >> 22n) % 6n);

    expect(defaultAvatarIndex({ id: USER_ID, discriminator: '0' })).toBe(expected);
    expect(defaultAvatarIndex({ id: USER_ID })).toBe(expected);
    expect(expected).toBeGreaterThanOrEqual(0);
    expect(expected).toBeLessThan(6);
  });

  it('usa la regola legacy quando c’è ancora un discriminator', () => {
    expect(defaultAvatarIndex({ id: USER_ID, discriminator: '0007' })).toBe(7 % 5);
  });

  it('non lancia su un ID non numerico', () => {
    expect(defaultAvatarIndex({ id: 'non-uno-snowflake' })).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// Frasi casuali
// -----------------------------------------------------------------------------

describe('pickRandom', () => {
  it('restituisce sempre un elemento dell’array', () => {
    const items = ['a', 'b', 'c'] as const;
    for (let i = 0; i < 50; i += 1) expect(items).toContain(pickRandom(items));
  });

  it('con un solo elemento restituisce quello', () => {
    expect(pickRandom(['solo'])).toBe('solo');
  });

  it('regge il caso limite di Math.random() === 1', () => {
    const spy = vi.spyOn(Math, 'random').mockReturnValue(1);
    try {
      expect(pickRandom(['a', 'b'])).toBe('b');
    } finally {
      spy.mockRestore();
    }
  });

  it('rifiuta un array vuoto invece di restituire undefined', () => {
    expect(() => pickRandom([])).toThrow();
  });

  it('le frasi configurate sono abbastanza e tutte distinte', () => {
    expect(WELCOME_PHRASES.length).toBeGreaterThanOrEqual(8);
    expect(GOODBYE_PHRASES.length).toBeGreaterThanOrEqual(8);
    expect(new Set(WELCOME_PHRASES).size).toBe(WELCOME_PHRASES.length);
    expect(new Set(GOODBYE_PHRASES).size).toBe(GOODBYE_PHRASES.length);
  });
});

// -----------------------------------------------------------------------------
// Embed
// -----------------------------------------------------------------------------

describe('embed di benvenuto', () => {
  const avatar = `https://cdn.discordapp.com/avatars/${USER_ID}/hash.png?size=1024`;

  it('menziona il nuovo membro e invita alla verifica', () => {
    const embed = embedOf(buildWelcomeMessage({ discordId: USER_ID, avatarUrl: avatar }));

    expect(embed.title).toBe('WELCOME TO THE EMPIRE');
    expect(embed.description).toContain(`<@${USER_ID}>`);
    expect(embed.description).toContain('completa la verifica');
    expect(embed.footer?.text).toBe(GANG_NAME);
  });

  it('mostra l’avatar in grande, non come thumbnail', () => {
    const embed = embedOf(buildWelcomeMessage({ discordId: USER_ID, avatarUrl: avatar }));

    expect(embed.image?.url).toBe(avatar);
    expect(embed.thumbnail).toBeUndefined();
  });

  it('include una frase presa dall’elenco configurato', () => {
    const embed = embedOf(buildWelcomeMessage({ discordId: USER_ID, avatarUrl: avatar }));

    expect(WELCOME_PHRASES.some((phrase) => embed.description?.includes(phrase))).toBe(true);
  });
});

describe('embed di addio', () => {
  const avatar = `https://cdn.discordapp.com/embed/avatars/1.png`;

  it('dice che ha lasciato il SERVER, mai la gang', () => {
    // Uscire dal Discord non è lasciare TTP: il messaggio pubblico non deve
    // far credere il contrario a chi lo legge.
    const embed = embedOf(
      buildGoodbyeMessage({ discordId: USER_ID, displayName: 'Tony', avatarUrl: avatar }),
    );

    expect(embed.title).toBe('LEFT THE EMPIRE');
    expect(embed.description).toContain('ha lasciato il server');
    expect(embed.description).not.toMatch(/gang|TTP|membership/i);
  });

  it('riporta l’ID nel footer: l’utente non è più menzionabile', () => {
    const embed = embedOf(
      buildGoodbyeMessage({ discordId: USER_ID, displayName: 'Tony', avatarUrl: avatar }),
    );

    expect(embed.footer?.text).toContain(USER_ID);
    expect(embed.image?.url).toBe(avatar);
  });

  it('neutralizza il markdown nel nome mostrato', () => {
    const embed = embedOf(
      buildGoodbyeMessage({ discordId: USER_ID, displayName: '**boss**', avatarUrl: avatar }),
    );

    expect(embed.description).toContain('\\*\\*boss\\*\\*');
  });
});

// -----------------------------------------------------------------------------
// Service
// -----------------------------------------------------------------------------

function createLifecycle(
  options: {
    user?: ApiUser | null;
    onSend?: (channelId: string) => void;
    onGetUser?: () => void;
  } = {},
) {
  const sent: Sent[] = [];
  const messages: LifecycleMessageGateway = {
    sendMessage(channelId, payload) {
      options.onSend?.(channelId);
      sent.push({ channelId, payload });
      return Promise.resolve('msg_1');
    },
    getUser() {
      options.onGetUser?.();
      return Promise.resolve(options.user === undefined ? null : options.user);
    },
  };

  const service = createMemberLifecycleMessageService({
    messages,
    channels: { welcome: WELCOME_CHANNEL, goodbye: GOODBYE_CHANNEL },
  });

  return { service, sent };
}

describe('MemberLifecycleMessageService', () => {
  it('pubblica il benvenuto sul canale di welcome', async () => {
    const { service, sent } = createLifecycle();

    const ok = await service.sendWelcome({ discordId: USER_ID, bot: false, avatar: 'hash' });

    expect(ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.channelId).toBe(WELCOME_CHANNEL);
    expect(embedOfSent(sent).image?.url).toContain(`avatars/${USER_ID}/hash.png`);
  });

  it('pubblica l’addio sul canale di goodbye', async () => {
    const { service, sent } = createLifecycle({
      user: { id: USER_ID, username: 'tony', avatar: 'a_anim' },
    });

    const ok = await service.sendGoodbye({ discordId: USER_ID, displayName: 'Tony' });

    expect(ok).toBe(true);
    expect(sent[0]?.channelId).toBe(GOODBYE_CHANNEL);
    expect(embedOfSent(sent).image?.url).toContain('.gif');
  });

  it('non interroga Discord quando avatar e flag bot sono già noti', async () => {
    // L'enumerazione del cron li porta già: una GET in più per ogni join
    // sarebbe budget sprecato sul piano gratuito.
    let lookups = 0;
    const { service } = createLifecycle({ onGetUser: () => (lookups += 1) });

    await service.sendWelcome({ discordId: USER_ID, bot: false, avatar: null });

    expect(lookups).toBe(0);
  });

  it('chiede il profilo quando l’avatar non è noto', async () => {
    let lookups = 0;
    const { service, sent } = createLifecycle({
      user: { id: USER_ID, username: 'tony', avatar: 'fromapi' },
      onGetUser: () => (lookups += 1),
    });

    await service.sendWelcome({ discordId: USER_ID });

    expect(lookups).toBe(1);
    expect(embedOfSent(sent).image?.url).toContain('fromapi');
  });

  it('non manda il benvenuto a un bot', async () => {
    const { service, sent } = createLifecycle();

    expect(await service.sendWelcome({ discordId: USER_ID, bot: true, avatar: null })).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('non manda il benvenuto a un bot riconosciuto solo dall’API', async () => {
    const { service, sent } = createLifecycle({
      user: { id: USER_ID, username: 'helper', bot: true },
    });

    expect(await service.sendWelcome({ discordId: USER_ID })).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('non manda l’addio a un bot', async () => {
    const { service, sent } = createLifecycle({
      user: { id: USER_ID, username: 'helper', bot: true },
    });

    expect(await service.sendGoodbye({ discordId: USER_ID, displayName: 'Helper' })).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('manda comunque l’addio se il profilo non è più recuperabile', async () => {
    // Account cancellato: senza avatar, ma il canale merita comunque il saluto.
    const { service, sent } = createLifecycle({ user: null });

    expect(await service.sendGoodbye({ discordId: USER_ID, displayName: 'Tony' })).toBe(true);
    expect(embedOfSent(sent).image?.url).toContain('embed/avatars/');
  });

  it('non lancia mai: un errore d’invio diventa `false`', async () => {
    // È il contratto su cui si regge la failure policy della riconciliazione.
    const messages: LifecycleMessageGateway = {
      sendMessage: () => Promise.reject(new Error('Missing Permissions')),
      getUser: () => Promise.resolve(null),
    };
    const service = createMemberLifecycleMessageService({
      messages,
      channels: { welcome: WELCOME_CHANNEL, goodbye: GOODBYE_CHANNEL },
    });

    await expect(
      service.sendWelcome({ discordId: USER_ID, bot: false, avatar: null }),
    ).resolves.toBe(false);
    await expect(service.sendGoodbye({ discordId: USER_ID, displayName: 'Tony' })).resolves.toBe(
      false,
    );
  });

  it('un profilo non recuperabile non fa perdere il benvenuto', async () => {
    const messages: LifecycleMessageGateway = {
      sendMessage: () => Promise.resolve('msg_1'),
      getUser: () => Promise.reject(new Error('Discord non raggiungibile')),
    };
    const service = createMemberLifecycleMessageService({
      messages,
      channels: { welcome: WELCOME_CHANNEL, goodbye: GOODBYE_CHANNEL },
    });

    await expect(service.sendWelcome({ discordId: USER_ID })).resolves.toBe(true);
  });
});
