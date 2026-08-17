/**
 * Risposte alle interaction HTTP.
 *
 * Il vincolo di Discord: la PRIMA risposta è il corpo HTTP della richiesta
 * stessa e deve partire entro 3 secondi. Tutto ciò che viene dopo passa
 * invece dagli endpoint webhook, autenticati dal token dell'interaction (e
 * quindi senza bot token).
 *
 * Questo modulo nasconde quella differenza: gli handler chiamano
 * `defer()` / `send()` come facevano con discord.js, e il responder decide
 * da sé se il messaggio è la risposta iniziale, una PATCH del messaggio
 * originale o un follow-up.
 *
 * Sicurezza: se un handler impiega troppo, il responder emette da solo una
 * risposta deferred prima dello scadere dei 3 secondi. Meglio un "sto
 * lavorando" seguito dal risultato che un "L'applicazione non ha risposto".
 */
import {
  InteractionResponseType,
  MessageFlags,
  type APIInteractionResponse,
  type APIApplicationCommandOptionChoice,
} from 'discord-api-types/v10';
import type { DiscordRest } from '../discord/rest.js';
import {
  type ApiMessagePayload,
  type MessagePayload,
  type ModalInput,
  toApiMessage,
  toApiMessageForEdit,
  toApiModal,
} from '../discord/payload.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('responder');

/**
 * Margine sui 3 secondi concessi da Discord.
 *
 * A 2.2s il Worker ha ancora tempo di serializzare e spedire la risposta
 * prima che Discord dichiari fallita l'interaction.
 */
export const AUTO_DEFER_MS = 2_200;

export interface SendOptions {
  /** Default `true`: le operazioni amministrative restano private. */
  readonly ephemeral?: boolean;
}

export interface InteractionResponder {
  /** L'interaction è già stata presa in carico con un deferred. */
  readonly deferred: boolean;
  /** È già stata inviata una risposta visibile. */
  readonly replied: boolean;

  /** Prende in carico l'interaction (DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE). */
  defer(options?: SendOptions): Promise<void>;
  /** Prende in carico un componente senza modificare il messaggio (type 6). */
  deferUpdate(): Promise<void>;

  /** Risponde, scegliendo da sé fra risposta iniziale, edit e follow-up. */
  send(payload: MessagePayload, options?: SendOptions): Promise<void>;
  /** Modifica il messaggio che contiene il componente cliccato (type 7). */
  update(payload: MessagePayload): Promise<void>;
  /** Apre un modal. È già la risposta all'interaction: niente defer prima. */
  showModal(modal: ModalInput): Promise<void>;
  /** Risponde a un autocomplete. */
  autocomplete(choices: readonly APIApplicationCommandOptionChoice[]): Promise<void>;

  /**
   * Il corpo HTTP della risposta iniziale.
   *
   * Si risolve appena un handler risponde, oppure da sé allo scadere del
   * margine sui 3 secondi.
   */
  initialResponse(): Promise<APIInteractionResponse>;
  /**
   * Chiude la fase iniziale: se nessuno ha risposto, emette un deferred.
   * Va chiamata quando il lavoro dell'handler è terminato.
   */
  settle(): void;
}

type State = 'pending' | 'deferred' | 'deferred-update' | 'replied';

export interface HttpResponderOptions {
  readonly rest: DiscordRest;
  readonly applicationId: string;
  readonly interactionToken: string;
  /** Iniettabile nei test: default `AUTO_DEFER_MS`. */
  readonly autoDeferMs?: number;
}

function withFlags(body: ApiMessagePayload, ephemeral: boolean): ApiMessagePayload {
  return ephemeral ? { ...body, flags: MessageFlags.Ephemeral } : body;
}

export function createHttpResponder(options: HttpResponderOptions): InteractionResponder {
  const { rest, applicationId, interactionToken } = options;
  const autoDeferMs = options.autoDeferMs ?? AUTO_DEFER_MS;

  let state: State = 'pending';
  let resolveInitial: ((response: APIInteractionResponse) => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const initial = new Promise<APIInteractionResponse>((resolve) => {
    resolveInitial = resolve;
  });

  function clearTimer(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  }

  /** Fissa la risposta iniziale. La prima chiamata vince, le altre sono no-op. */
  function emitInitial(response: APIInteractionResponse): boolean {
    if (resolveInitial === undefined) return false;
    clearTimer();
    resolveInitial(response);
    resolveInitial = undefined;
    return true;
  }

  function deferBody(ephemeral: boolean): APIInteractionResponse {
    return {
      type: InteractionResponseType.DeferredChannelMessageWithSource,
      data: ephemeral ? { flags: MessageFlags.Ephemeral } : {},
    };
  }

  // --- Endpoint webhook: autenticati dal token dell'interaction ------------
  const originalPath = `/webhooks/${applicationId}/${interactionToken}/messages/@original`;
  const followupPath = `/webhooks/${applicationId}/${interactionToken}`;

  async function editOriginal(payload: MessagePayload): Promise<void> {
    await rest.unauthenticated({
      method: 'PATCH',
      path: originalPath,
      body: toApiMessageForEdit(payload),
    });
  }

  async function followUp(payload: MessagePayload, ephemeral: boolean): Promise<void> {
    await rest.unauthenticated({
      method: 'POST',
      path: followupPath,
      body: withFlags(toApiMessage(payload), ephemeral),
    });
  }

  const responder: InteractionResponder = {
    get deferred(): boolean {
      return state === 'deferred' || state === 'deferred-update';
    },
    get replied(): boolean {
      return state === 'replied';
    },

    defer(opts = {}): Promise<void> {
      if (state !== 'pending') return Promise.resolve();
      state = 'deferred';
      emitInitial(deferBody(opts.ephemeral ?? true));
      return Promise.resolve();
    },

    deferUpdate(): Promise<void> {
      if (state !== 'pending') return Promise.resolve();
      state = 'deferred-update';
      emitInitial({ type: InteractionResponseType.DeferredMessageUpdate });
      return Promise.resolve();
    },

    async send(payload, opts = {}): Promise<void> {
      const ephemeral = opts.ephemeral ?? true;

      try {
        if (state === 'pending') {
          state = 'replied';
          emitInitial({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: withFlags(toApiMessage(payload), ephemeral),
          });
          return;
        }

        if (state === 'deferred' || state === 'deferred-update') {
          state = 'replied';
          await editOriginal(payload);
          return;
        }

        await followUp(payload, ephemeral);
      } catch (error) {
        // Un fallimento nel rispondere non deve propagarsi: l'operazione di
        // dominio potrebbe essere andata a buon fine.
        log.error({ err: error, state }, 'Risposta all’interaction non riuscita');
      }
    },

    async update(payload): Promise<void> {
      try {
        if (state === 'pending') {
          state = 'replied';
          emitInitial({
            type: InteractionResponseType.UpdateMessage,
            data: toApiMessageForEdit(payload),
          });
          return;
        }
        state = 'replied';
        await editOriginal(payload);
      } catch (error) {
        log.error({ err: error, state }, 'Aggiornamento del messaggio non riuscito');
      }
    },

    showModal(modal): Promise<void> {
      if (state !== 'pending') {
        // Un modal si può aprire solo come PRIMA risposta: dopo un defer
        // Discord lo rifiuterebbe. Segnaliamo invece di produrre un errore
        // incomprensibile lato utente.
        log.warn({ state }, 'showModal richiesto quando l’interaction era già stata gestita');
        return Promise.resolve();
      }
      state = 'replied';
      emitInitial({ type: InteractionResponseType.Modal, data: toApiModal(modal) });
      return Promise.resolve();
    },

    autocomplete(choices): Promise<void> {
      if (state !== 'pending') return Promise.resolve();
      state = 'replied';
      emitInitial({
        type: InteractionResponseType.ApplicationCommandAutocompleteResult,
        data: { choices: [...choices] },
      });
      return Promise.resolve();
    },

    initialResponse(): Promise<APIInteractionResponse> {
      // Rete di sicurezza sui 3 secondi: se l'handler è ancora al lavoro,
      // prendiamo noi in carico l'interaction con un deferred ephemeral.
      if (resolveInitial !== undefined && timer === undefined) {
        timer = setTimeout(() => {
          if (state === 'pending') {
            state = 'deferred';
            log.warn({}, 'Risposta automatica deferred: handler oltre il margine dei 3 secondi');
          }
          emitInitial(deferBody(true));
        }, autoDeferMs);
      }
      return initial;
    },

    settle(): void {
      // L'handler ha finito senza rispondere (o è fallito prima di poterlo
      // fare): Discord esige comunque un corpo valido.
      if (state === 'pending' && resolveInitial !== undefined) state = 'deferred';
      emitInitial(deferBody(true));
    },
  };

  return responder;
}
