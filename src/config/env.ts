/**
 * Validazione e tipizzazione centralizzata dell'environment.
 *
 * Regole:
 *  - lo startup si interrompe se manca una variabile fondamentale;
 *  - i secret non vengono MAI stampati, nemmeno in caso di errore;
 *  - ogni snowflake viene validato nel formato.
 *
 * NOTA runtime: questo modulo non importa nulla di specifico di Node, cosi'
 * puo' girare identico sul Worker. La sorgente delle variabili e' un
 * semplice dizionario: `process.env` su Node, il binding `Env` su Workers.
 */

/** Uno snowflake Discord: 17-20 cifre decimali. */
const SNOWFLAKE_PATTERN = /^\d{17,20}$/;

/** Chiave pubblica Ed25519 dell'applicazione: 32 byte in esadecimale. */
const PUBLIC_KEY_PATTERN = /^[0-9a-f]{64}$/i;

/** Variabili il cui valore non deve mai comparire in un messaggio d'errore. */
const SECRET_KEYS = new Set(['DISCORD_TOKEN', 'DISCORD_PUBLIC_KEY', 'DATABASE_URL', 'DIRECT_URL']);

/** Sorgente delle variabili d'ambiente: process.env, bindings del Worker, … */
export type EnvSource = Readonly<Record<string, string | undefined>>;

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const NODE_ENVS = ['development', 'test', 'production'] as const;
export type NodeEnv = (typeof NODE_ENVS)[number];

class EnvironmentError extends Error {
  public constructor(problems: string[]) {
    super(
      [
        'Configurazione environment non valida.',
        '',
        ...problems.map((p) => `  - ${p}`),
        '',
        'Compila i valori mancanti: `.env` in locale, `vars` di wrangler.jsonc',
        'e `wrangler secret put` per i secret. Vedi .env.example.',
      ].join('\n'),
    );
    this.name = 'EnvironmentError';
  }
}

/** Accumula tutti i problemi invece di fallire al primo: un solo giro di fix. */
class EnvReader {
  private readonly problems: string[] = [];

  private readonly source: EnvSource;

  public constructor(source: EnvSource) {
    this.source = source;
  }

  private raw(key: string): string | undefined {
    const value = this.source[key];
    if (value === undefined) return undefined;
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  }

  /** Descrive un valore invalido senza rivelarlo se la chiave e' un secret. */
  private describe(key: string, value: string): string {
    if (SECRET_KEYS.has(key)) return '<valore nascosto>';
    return `"${value}"`;
  }

  public string(key: string): string {
    const value = this.raw(key);
    if (value === undefined) {
      this.problems.push(`${key} mancante`);
      return '';
    }
    return value;
  }

  public snowflake(key: string): string {
    const value = this.raw(key);
    if (value === undefined) {
      this.problems.push(`${key} mancante`);
      return '';
    }
    if (!SNOWFLAKE_PATTERN.test(value)) {
      this.problems.push(
        `${key} non e' uno snowflake Discord valido (17-20 cifre): ${this.describe(key, value)}`,
      );
      return '';
    }
    return value;
  }

  public postgresUrl(key: string, { required }: { required: boolean }): string | undefined {
    const value = this.raw(key);
    if (value === undefined) {
      if (required) this.problems.push(`${key} mancante`);
      return undefined;
    }
    if (!/^postgres(ql)?:\/\//.test(value)) {
      // Non includiamo mai il valore: e' una connection string con password.
      this.problems.push(`${key} deve iniziare con postgresql:// o postgres://`);
      return undefined;
    }
    return value;
  }

  public discordToken(key: string): string {
    const value = this.raw(key);
    if (value === undefined) {
      this.problems.push(`${key} mancante`);
      return '';
    }
    // Un bot token ha tre segmenti separati da punto. Controllo di forma,
    // volutamente permissivo: il formato non e' documentato come stabile.
    if (value.split('.').length < 3 || value.length < 50) {
      this.problems.push(`${key} non sembra un bot token Discord valido`);
      return '';
    }
    return value;
  }

  /**
   * Chiave pubblica Ed25519 dell'applicazione Discord.
   *
   * NON e' il bot token: si trova nel Developer Portal sotto
   * General Information → Public Key, ed e' cio' con cui si verifica la firma
   * di ogni interaction HTTP. Non e' tecnicamente un segreto (e' pubblica),
   * ma trattarla come tale nei messaggi d'errore non costa nulla.
   */
  public publicKey(key: string): string {
    const value = this.raw(key);
    if (value === undefined) {
      this.problems.push(`${key} mancante`);
      return '';
    }
    if (!PUBLIC_KEY_PATTERN.test(value)) {
      this.problems.push(
        `${key} deve essere la Public Key Ed25519 dell'applicazione: 64 caratteri esadecimali ` +
          "(Developer Portal → General Information → Public Key). Non e' il bot token.",
      );
      return '';
    }
    return value.toLowerCase();
  }

  public enum<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
    const value = this.raw(key);
    if (value === undefined) return fallback;
    if (!(allowed as readonly string[]).includes(value)) {
      this.problems.push(`${key} deve essere uno di: ${allowed.join(', ')} (ricevuto "${value}")`);
      return fallback;
    }
    return value as T;
  }

  public finish(): void {
    if (this.problems.length > 0) throw new EnvironmentError(this.problems);
  }
}

function build(source: EnvSource) {
  const read = new EnvReader(source);

  const parsed = {
    nodeEnv: read.enum('NODE_ENV', NODE_ENVS, 'development'),
    logLevel: read.enum('LOG_LEVEL', LOG_LEVELS, 'info'),

    discordToken: read.discordToken('DISCORD_TOKEN'),
    /** Verifica della firma delle interaction HTTP. NON e' il bot token. */
    discordPublicKey: read.publicKey('DISCORD_PUBLIC_KEY'),
    clientId: read.snowflake('CLIENT_ID'),
    guildId: read.snowflake('GUILD_ID'),
    ownerId: read.snowflake('OWNER_ID'),

    /** Endpoint POOLED di Neon: usato a runtime dal driver adapter. */
    databaseUrl: read.postgresUrl('DATABASE_URL', { required: true }) ?? '',
    /** Endpoint DIRECT di Neon: usato solo dalla Prisma CLI. */
    directUrl: read.postgresUrl('DIRECT_URL', { required: false }),

    roles: {
      verified: read.snowflake('ROLE_VERIFIED_ID'),
      ttp: read.snowflake('ROLE_TTP_ID'),

      og: read.snowflake('ROLE_OG_ID'),
      big: read.snowflake('ROLE_BIG_ID'),
      youngOg: read.snowflake('ROLE_YOUNG_OG_ID'),
      gangster: read.snowflake('ROLE_GANGSTER_ID'),
      resident: read.snowflake('ROLE_RESIDENT_ID'),

      friend: read.snowflake('ROLE_FRIEND_ID'),
      mafia: read.snowflake('ROLE_MAFIA_ID'),

      banned: read.snowflake('ROLE_BANNED_ID'),
      inactive: read.snowflake('ROLE_INACTIVE_ID'),
      permadeath: read.snowflake('ROLE_PERMADEATH_ID'),

      honor1: read.snowflake('ROLE_HONOR_1_ID'),
      honor2: read.snowflake('ROLE_HONOR_2_ID'),
      supporter: read.snowflake('ROLE_SUPPORTER_ID'),
      firstDay: read.snowflake('ROLE_FIRST_DAY_ID'),

      shooter: read.snowflake('ROLE_SHOOTER_ID'),
      mainShooter: read.snowflake('ROLE_MAIN_SHOOTER_ID'),
    },

    channels: {
      verify: read.snowflake('CHANNEL_VERIFY_ID'),
      verifyRequests: read.snowflake('CHANNEL_VERIFY_REQUESTS_ID'),
      memberManagement: read.snowflake('CHANNEL_MEMBER_MANAGEMENT_ID'),
      memberLogs: read.snowflake('CHANNEL_MEMBER_LOGS_ID'),
      auditLog: read.snowflake('CHANNEL_AUDIT_LOG_ID'),
      blacklist: read.snowflake('CHANNEL_BLACKLIST_ID'),
      controlPanel: read.snowflake('CHANNEL_CONTROL_PANEL_ID'),
      /** Messaggi automatici di benvenuto (riconciliazione: nuovo membro). */
      welcome: read.snowflake('CHANNEL_WELCOME_ID'),
      /** Messaggi automatici di addio (riconciliazione: membro uscito). */
      goodbye: read.snowflake('CHANNEL_GOODBYE_ID'),
    },
  } as const;

  read.finish();
  return parsed;
}

export type Env = ReturnType<typeof build>;

/**
 * Valida una sorgente di variabili e ne restituisce la versione tipizzata.
 *
 * Funzione pura, senza cache: e' quella usata dal Worker, dove ogni
 * invocazione riceve i propri binding e non c'e' nessun `process` globale.
 *
 * @throws EnvironmentError se manca o e' malformata una variabile richiesta.
 */
export function buildEnv(source: EnvSource): Env {
  return build(source);
}

let cached: Env | undefined;

/**
 * Carica e valida l'environment da `process.env`. Il risultato viene
 * memorizzato: chiamate successive non ripetono la validazione.
 *
 * Usata dagli script Node (`commands:deploy`); il Worker usa `buildEnv`.
 *
 * @throws EnvironmentError se manca o e' malformata una variabile richiesta.
 */
export function loadEnv(source?: EnvSource): Env {
  // `process` viene letto dal globale invece che importato: cosi' il modulo
  // resta compilabile anche con i soli tipi di Workers, dove non esiste.
  const fallback = (globalThis as { process?: { env?: EnvSource } }).process?.env ?? {};
  cached ??= build(source ?? fallback);
  return cached;
}

/** Solo per i test: azzera la cache tra un caso e l'altro. */
export function resetEnvCache(): void {
  cached = undefined;
}

export { EnvironmentError };
