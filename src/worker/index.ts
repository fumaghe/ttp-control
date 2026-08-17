/**
 * TTP CONTROL — Cloudflare Worker.
 *
 * Due punti d'ingresso, nessun processo persistente:
 *
 *   fetch()     → Discord Interactions Endpoint (POST /interactions)
 *   scheduled() → Cron Trigger, riconciliazione dei membri
 *
 * Il vincolo che determina la forma di questo file: Discord chiude
 * l'interaction se non riceve una risposta entro 3 secondi. Il Worker quindi
 * NON aspetta che l'handler finisca — spedisce la prima risposta appena il
 * responder ne produce una (tipicamente un deferred) e lascia proseguire il
 * lavoro dentro `waitUntil`, che è il modo con cui i Worker continuano a
 * girare dopo aver risposto.
 */
import {
  InteractionResponseType,
  InteractionType,
  type APIInteraction,
} from 'discord-api-types/v10';
import { buildEnv, EnvironmentError, type Env } from '../config/env.js';
import { createDatabase, disconnectDatabase } from '../database/prisma.js';
import { createDiscordRest } from '../discord/rest.js';
import { buildInteractionContext } from '../http/interactionContext.js';
import { createHttpResponder } from '../http/responder.js';
import { routeInteraction } from '../http/router.js';
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifyDiscordRequest } from '../http/signature.js';
import { BOT_NAME, BOT_VERSION } from '../config/constants.js';
import { initLogger, createLogger } from '../utils/logger.js';
import {
  resolveDatabaseUrl,
  toEnvSource,
  usesHyperdrive,
  type WorkerBindings,
} from './bindings.js';
import { createWorkerContext } from './context.js';

const log = createLogger('worker');

/**
 * Sottoinsieme di `ExecutionContext` che il Worker usa davvero.
 *
 * Dichiarato qui invece di dipendere dal tipo globale di
 * `@cloudflare/workers-types`: così questo modulo resta compilabile e
 * testabile anche sotto i tipi di Node, dove quel globale non esiste.
 */
export interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

/** Il controller passato da un Cron Trigger. */
export interface WorkerScheduledController {
  readonly cron: string;
}

/** Percorsi accettati per il webhook delle interaction. */
const INTERACTION_PATHS = new Set(['/', '/interactions']);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/**
 * Risposta a una firma non valida.
 *
 * Volutamente identica in ogni caso di fallimento: distinguere "firma
 * sbagliata" da "timestamp scaduto" direbbe a chi sonda l'endpoint quanto si
 * è avvicinato.
 */
function unauthorized(): Response {
  return new Response('invalid request signature', { status: 401 });
}

/** L'environment viene validato una volta per isolate, non a ogni richiesta. */
let cachedEnv: Env | undefined;
let cachedEnvError: EnvironmentError | undefined;

function readEnv(bindings: WorkerBindings): Env {
  if (cachedEnvError) throw cachedEnvError;
  if (cachedEnv) return cachedEnv;

  try {
    const env = buildEnv(toEnvSource(bindings));
    initLogger({ level: env.logLevel, pretty: env.nodeEnv === 'development' });
    cachedEnv = env;
    return env;
  } catch (error) {
    if (error instanceof EnvironmentError) cachedEnvError = error;
    throw error;
  }
}

export default {
  async fetch(
    request: Request,
    bindings: WorkerBindings,
    ctx: WorkerExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    // --- Health check ------------------------------------------------------
    // Utile per verificare che il deploy sia vivo senza dover firmare una
    // richiesta. Non espone nulla di configurato.
    if (request.method === 'GET' && INTERACTION_PATHS.has(url.pathname)) {
      return new Response(`${BOT_NAME} v${BOT_VERSION} — interactions endpoint attivo`, {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }

    if (request.method !== 'POST') {
      return new Response('method not allowed', { status: 405, headers: { allow: 'GET, POST' } });
    }
    if (!INTERACTION_PATHS.has(url.pathname)) {
      return new Response('not found', { status: 404 });
    }

    let env: Env;
    try {
      env = readEnv(bindings);
    } catch (error) {
      // Configurazione incompleta: il messaggio è già esplicativo e non
      // contiene secret, ma non deve uscire dall'endpoint pubblico.
      log.fatal({ err: error }, 'Configurazione del Worker non valida');
      return new Response('worker misconfigured', { status: 500 });
    }

    // --- Firma Ed25519: l'UNICA autenticazione di questo endpoint ---------
    // Il corpo va letto GREZZO: la firma copre i byte esatti inviati da
    // Discord, non un JSON riserializzato.
    const rawBody = await request.text();
    const signature = await verifyDiscordRequest({
      rawBody,
      signature: request.headers.get(SIGNATURE_HEADER),
      timestamp: request.headers.get(TIMESTAMP_HEADER),
      publicKey: env.discordPublicKey,
    });

    if (!signature.valid) {
      log.warn({ reason: signature.reason }, 'Richiesta rifiutata: firma non valida');
      return unauthorized();
    }

    let interaction: APIInteraction;
    try {
      interaction = JSON.parse(rawBody) as APIInteraction;
    } catch {
      return new Response('malformed payload', { status: 400 });
    }

    // --- PING di validazione di Discord ----------------------------------
    // È quello che Discord invia quando si salva l'Interactions Endpoint URL.
    if (interaction.type === InteractionType.Ping) {
      return json({ type: InteractionResponseType.Pong });
    }

    // --- Contesto applicativo ---------------------------------------------
    const db = createDatabase({
      databaseUrl: resolveDatabaseUrl(bindings, env.databaseUrl),
      logQueries: env.nodeEnv === 'development' && env.logLevel === 'debug',
    });

    const rest = createDiscordRest({ token: env.discordToken });
    const responder = createHttpResponder({
      rest,
      applicationId: interaction.application_id,
      interactionToken: interaction.token,
    });

    const { app } = createWorkerContext({ env, db });

    let interactionContext;
    try {
      interactionContext = buildInteractionContext({ interaction, responder });
    } catch (error) {
      log.warn({ err: error }, 'Payload di interaction non interpretabile');
      ctx.waitUntil(disconnectDatabase(db));
      return new Response('malformed payload', { status: 400 });
    }

    // Il lavoro prosegue oltre la risposta HTTP: è così che un Worker
    // completa un'operazione lunga dopo aver già risposto a Discord.
    const work = (async (): Promise<void> => {
      try {
        await routeInteraction(interactionContext, app);
      } catch (error) {
        log.error({ err: error }, 'Errore non gestito nel routing');
      } finally {
        // Se nessuno ha risposto, il responder emette comunque un corpo
        // valido: Discord non deve mai vedere una richiesta senza risposta.
        responder.settle();
        await disconnectDatabase(db);
      }
    })();

    ctx.waitUntil(work);

    return json(await responder.initialResponse());
  },

  /**
   * Cron Trigger.
   *
   * Rimpiazza i tre eventi di membership del Gateway: confronta lo stato
   * Discord con l'ultimo snapshot e ne deduce join, uscite e modifiche
   * manuali dei ruoli. Vedi `memberReconciliationService`.
   */
  async scheduled(
    event: WorkerScheduledController,
    bindings: WorkerBindings,
    ctx: WorkerExecutionContext,
  ): Promise<void> {
    let env: Env;
    try {
      env = readEnv(bindings);
    } catch (error) {
      log.fatal({ err: error }, 'Cron non eseguito: configurazione non valida');
      return;
    }

    const db = createDatabase({
      databaseUrl: resolveDatabaseUrl(bindings, env.databaseUrl),
    });

    try {
      const { app } = createWorkerContext({ env, db });
      const report = await app.reconciliation.run();
      log.info(
        { cron: event.cron, hyperdrive: usesHyperdrive(bindings), ...report },
        'Cron completato',
      );
    } catch (error) {
      // Una failure del cron non deve lasciare stato a metà: gli snapshot
      // vengono scritti solo per i membri trattati con successo, quindi la
      // prossima esecuzione riparte da dove si era fermata.
      log.error({ err: error, cron: event.cron }, 'Riconciliazione fallita');
    } finally {
      ctx.waitUntil(disconnectDatabase(db));
    }
  },
};
