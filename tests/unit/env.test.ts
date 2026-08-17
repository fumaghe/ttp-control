/**
 * Validazione dell'environment.
 *
 * Il punto delicato: fallire con un messaggio utile senza mai stampare un
 * secret, nemmeno quando è proprio il secret a essere malformato.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { buildChannelRegistry } from '../../src/config/channels.js';
import { EnvironmentError, loadEnv, resetEnvCache } from '../../src/config/env.js';

/**
 * Token fittizio con la forma giusta (tre segmenti separati da punto).
 * Composto a runtime di proposito: un literal token-shaped farebbe scattare
 * il secret scanner di GitHub, che non puo' sapere che e' finto.
 */
const VALID_TOKEN = ['MTIzNDU2Nzg5MDEyMzQ1Njc4', 'GaBcDe', 'x'.repeat(30)].join('.');
const VALID_URL = 'postgresql://user:supersecret@host.neon.tech/db?sslmode=require';

/** Public Key Ed25519 fittizia: 32 byte in esadecimale. */
const VALID_PUBLIC_KEY = 'ab'.repeat(32);

function completeEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const base: Record<string, string> = {
    DISCORD_TOKEN: VALID_TOKEN,
    DISCORD_PUBLIC_KEY: VALID_PUBLIC_KEY,
    CLIENT_ID: '100000000000000001',
    GUILD_ID: '100000000000000002',
    OWNER_ID: '100000000000000003',
    DATABASE_URL: VALID_URL,
    ROLE_VERIFIED_ID: '200000000000000001',
    ROLE_TTP_ID: '200000000000000002',
    ROLE_OG_ID: '200000000000000003',
    ROLE_BIG_HOMIE_ID: '200000000000000004',
    ROLE_BIG_ID: '200000000000000019',
    ROLE_ORIGINAL_TINY_LOC_ID: '200000000000000005',
    ROLE_LOC_ID: '200000000000000020',
    ROLE_TINY_LOC_ID: '200000000000000006',
    ROLE_INFANTIL_LOC_ID: '200000000000000021',
    ROLE_GANG_BANGER_ID: '200000000000000022',
    ROLE_RESIDENT_ID: '200000000000000007',
    ROLE_FRIEND_ID: '200000000000000008',
    ROLE_MAFIA_ID: '200000000000000009',
    ROLE_BANNED_ID: '200000000000000010',
    ROLE_INACTIVE_ID: '200000000000000011',
    ROLE_PERMADEATH_ID: '200000000000000012',
    ROLE_HONOR_1_ID: '200000000000000013',
    ROLE_HONOR_2_ID: '200000000000000014',
    ROLE_SUPPORTER_ID: '200000000000000015',
    ROLE_FIRST_DAY_ID: '200000000000000016',
    ROLE_SHOOTER_ID: '200000000000000017',
    ROLE_MAIN_SHOOTER_ID: '200000000000000018',
    CHANNEL_VERIFY_ID: '300000000000000001',
    CHANNEL_VERIFY_REQUESTS_ID: '300000000000000002',
    CHANNEL_MEMBER_MANAGEMENT_ID: '300000000000000003',
    CHANNEL_MEMBER_LOGS_ID: '300000000000000004',
    CHANNEL_AUDIT_LOG_ID: '300000000000000005',
    CHANNEL_BLACKLIST_ID: '300000000000000006',
    CHANNEL_CONTROL_PANEL_ID: '300000000000000007',
    CHANNEL_WELCOME_ID: '300000000000000008',
    CHANNEL_GOODBYE_ID: '300000000000000009',
    CHANNEL_PUT_ON_OFF_ID: '300000000000000010',
  };

  // Le chiavi con override `undefined` vengono semplicemente escluse:
  // e' il modo di simulare "variabile non impostata".
  return Object.fromEntries(
    Object.entries({ ...base, ...overrides }).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

afterEach(() => {
  resetEnvCache();
});

describe('configurazione valida', () => {
  it('espone gli ID tipizzati', () => {
    const env = loadEnv(completeEnv());
    expect(env.roles.verified).toBe('200000000000000001');
    expect(env.roles.ttp).toBe('200000000000000002');
    expect(env.channels.verify).toBe('300000000000000001');
  });

  it('normalizza la public key in minuscolo', () => {
    const env = loadEnv(completeEnv({ DISCORD_PUBLIC_KEY: VALID_PUBLIC_KEY.toUpperCase() }));
    expect(env.discordPublicKey).toBe(VALID_PUBLIC_KEY);
  });

  it('DIRECT_URL è facoltativo', () => {
    const env = loadEnv(completeEnv());
    expect(env.directUrl).toBeUndefined();
  });

  it('usa i default per NODE_ENV e LOG_LEVEL', () => {
    const env = loadEnv(completeEnv());
    expect(env.nodeEnv).toBe('development');
    expect(env.logLevel).toBe('info');
  });
});

describe('configurazione mancante', () => {
  it('fallisce se manca ROLE_VERIFIED_ID', () => {
    expect(() => loadEnv(completeEnv({ ROLE_VERIFIED_ID: undefined }))).toThrow(EnvironmentError);
  });

  it('fallisce se manca DATABASE_URL', () => {
    expect(() => loadEnv(completeEnv({ DATABASE_URL: undefined }))).toThrow(EnvironmentError);
  });

  it('elenca TUTTI i problemi in una volta sola', () => {
    try {
      loadEnv(completeEnv({ ROLE_TTP_ID: undefined, CHANNEL_VERIFY_ID: undefined }));
      expect.unreachable('avrebbe dovuto lanciare');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('ROLE_TTP_ID');
      expect(message).toContain('CHANNEL_VERIFY_ID');
    }
  });
});

describe('canali di benvenuto e addio', () => {
  it('sono obbligatori come ogni altro canale', () => {
    expect(() => loadEnv(completeEnv({ CHANNEL_WELCOME_ID: undefined }))).toThrow(EnvironmentError);
    resetEnvCache();
    expect(() => loadEnv(completeEnv({ CHANNEL_GOODBYE_ID: undefined }))).toThrow(EnvironmentError);
  });

  it('finiscono nel registry, quindi anche nei controlli di `/setup check`', () => {
    const env = loadEnv(completeEnv());
    const channels = buildChannelRegistry(env);

    expect(channels.welcome).toBe('300000000000000008');
    expect(channels.goodbye).toBe('300000000000000009');

    // `/setup check` itera esattamente su `all`: esserci significa essere
    // verificati per esistenza e permessi (View / Send / Embed Links).
    const keys = channels.all.map((descriptor) => descriptor.key);
    expect(keys).toContain('welcome');
    expect(keys).toContain('goodbye');
    expect(channels.all.filter((d) => d.key === 'welcome' || d.key === 'goodbye')).toHaveLength(2);
  });
});

describe('configurazione malformata', () => {
  it('rifiuta uno snowflake non valido e lo mostra', () => {
    try {
      loadEnv(completeEnv({ ROLE_TTP_ID: 'non-un-id' }));
      expect.unreachable('avrebbe dovuto lanciare');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('ROLE_TTP_ID');
      // Gli ID dei ruoli non sono segreti: mostrarli aiuta a correggerli.
      expect(message).toContain('non-un-id');
    }
  });

  it('rifiuta una connection string non PostgreSQL SENZA stamparla', () => {
    try {
      loadEnv(completeEnv({ DATABASE_URL: 'mysql://user:hunter2@host/db' }));
      expect.unreachable('avrebbe dovuto lanciare');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('DATABASE_URL');
      // Il valore è un secret: non deve comparire mai, nemmeno se sbagliato.
      expect(message).not.toContain('hunter2');
      expect(message).not.toContain('mysql://');
    }
  });

  it('rifiuta un token malformato SENZA stamparlo', () => {
    try {
      loadEnv(completeEnv({ DISCORD_TOKEN: 'token-corto-ma-segreto' }));
      expect.unreachable('avrebbe dovuto lanciare');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('DISCORD_TOKEN');
      expect(message).not.toContain('token-corto-ma-segreto');
    }
  });

  it('rifiuta una DISCORD_PUBLIC_KEY che non è esadecimale a 64 caratteri', () => {
    // L'errore tipico: incollare il bot token al posto della public key.
    try {
      loadEnv(completeEnv({ DISCORD_PUBLIC_KEY: VALID_TOKEN }));
      expect.unreachable('avrebbe dovuto lanciare');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('DISCORD_PUBLIC_KEY');
      expect(message).toContain('Public Key');
      // È un secret nell'elenco: il valore non deve mai comparire.
      expect(message).not.toContain(VALID_TOKEN);
    }
  });

  it('fallisce se manca DISCORD_PUBLIC_KEY', () => {
    expect(() => loadEnv(completeEnv({ DISCORD_PUBLIC_KEY: undefined }))).toThrow(EnvironmentError);
  });

  it('rifiuta un LOG_LEVEL sconosciuto', () => {
    expect(() => loadEnv(completeEnv({ LOG_LEVEL: 'verbose' }))).toThrow(EnvironmentError);
  });
});
