/**
 * TTP CONTROL — entrypoint.
 *
 * Sequenza di avvio:
 *   1. validazione environment (fallisce subito se manca qualcosa)
 *   2. logger
 *   3. database
 *   4. Discord client
 *   5. composizione del contesto
 *   6. registrazione degli eventi
 *   7. graceful shutdown
 */
import { Events } from 'discord.js';
import { createClient } from './client/createClient.js';
import { createContext } from './client/createContext.js';
import { BOT_NAME, BOT_VERSION } from './config/constants.js';
import { EnvironmentError, loadEnv } from './config/env.js';
import { connectDatabase, createDatabase, disconnectDatabase } from './database/prisma.js';
import {
  onGuildMemberAdd,
  onGuildMemberRemove,
  onGuildMemberUpdate,
} from './events/guildMemberEvents.js';
import { handleInteraction } from './events/interactionCreate.js';
import type { AppContext } from './types/context.js';
import { initLogger, getLogger } from './utils/logger.js';
import { sanitizeDatabaseUrl } from './utils/redact.js';

async function main(): Promise<void> {
  const startedAt = new Date();

  // --- 1. Environment ------------------------------------------------------
  const env = loadEnv();

  // --- 2. Logger -----------------------------------------------------------
  const log = initLogger({
    level: env.logLevel,
    pretty: env.nodeEnv === 'development',
  });

  log.info(
    {
      version: BOT_VERSION,
      nodeEnv: env.nodeEnv,
      node: process.version,
      // Solo host e nome del database: mai la connection string completa.
      database: sanitizeDatabaseUrl(env.databaseUrl),
    },
    `${BOT_NAME} in avvio`,
  );

  // --- 3. Database ---------------------------------------------------------
  const db = createDatabase({
    databaseUrl: env.databaseUrl,
    logQueries: env.nodeEnv === 'development' && env.logLevel === 'debug',
  });
  await connectDatabase(db, env.databaseUrl);

  // --- 4. Discord ----------------------------------------------------------
  const client = createClient();
  let context: AppContext | undefined;

  client.once(Events.ClientReady, (ready) => {
    void (async () => {
      try {
        const guild = await ready.guilds.fetch(env.guildId);
        const fullGuild = await guild.fetch();

        context = createContext({
          client: ready,
          guild: fullGuild,
          env,
          db,
          startedAt,
        });

        // Assicura che la configurazione della guild esista fin da subito.
        await context.repos.guildConfig.ensure(fullGuild.id);

        log.info(
          {
            bot: ready.user.tag,
            guild: fullGuild.name,
            guildId: fullGuild.id,
            members: fullGuild.memberCount,
          },
          'Bot online',
        );
      } catch (error) {
        log.fatal({ err: error }, 'Inizializzazione fallita dopo il ready');
        await shutdown('startup-failure', 1);
      }
    })();
  });

  // Gli handler girano solo a contesto pronto: nei primi istanti dopo il
  // ready gli eventi vengono ignorati invece di usare un contesto parziale.
  client.on(Events.InteractionCreate, (interaction) => {
    if (!context) return;
    void handleInteraction(interaction, context);
  });

  client.on(Events.GuildMemberAdd, (member) => {
    if (!context) return;
    void onGuildMemberAdd(member, context);
  });

  client.on(Events.GuildMemberRemove, (member) => {
    if (!context) return;
    void onGuildMemberRemove(member, context);
  });

  client.on(Events.GuildMemberUpdate, (oldMember, newMember) => {
    if (!context) return;
    void onGuildMemberUpdate(oldMember, newMember, context);
  });

  client.on(Events.Error, (error) => {
    log.error({ err: error }, 'Errore del client Discord');
  });

  client.on(Events.Warn, (message) => {
    log.warn({ message }, 'Avviso dal client Discord');
  });

  // --- 5. Graceful shutdown -------------------------------------------------
  let shuttingDown = false;

  async function shutdown(signal: string, exitCode = 0): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    log.info({ signal }, 'Arresto in corso');
    try {
      await client.destroy();
      await disconnectDatabase();
      log.info('Arresto completato');
    } catch (error) {
      log.error({ err: error }, 'Errore durante l’arresto');
      exitCode = 1;
    }
    process.exit(exitCode);
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }

  process.on('unhandledRejection', (reason) => {
    log.error({ err: reason }, 'Promise rifiutata senza handler');
  });

  process.on('uncaughtException', (error) => {
    log.fatal({ err: error }, 'Eccezione non gestita: arresto');
    void shutdown('uncaughtException', 1);
  });

  await client.login(env.discordToken);
}

main().catch((error: unknown) => {
  const log = getLogger();

  if (error instanceof EnvironmentError) {
    // Configurazione mancante: il messaggio è già esplicativo e non contiene
    // secret. Niente stack trace, sarebbe solo rumore.
    log.fatal(error.message);
  } else {
    log.fatal({ err: error }, 'Avvio fallito');
  }

  process.exit(1);
});
