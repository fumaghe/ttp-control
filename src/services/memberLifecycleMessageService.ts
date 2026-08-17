/**
 * Messaggi automatici di benvenuto e addio.
 *
 * Adapter fra la riconciliazione e Discord: la riconciliazione dice soltanto
 * "questo membro è entrato" / "questo membro è uscito", qui si decide se un
 * messaggio ha senso, lo si costruisce e lo si invia.
 *
 * BEST-EFFORT PER CONTRATTO: nessun metodo di questo service lancia mai.
 * Un messaggio non recapitato è un problema di UI; la riconciliazione, l'audit
 * e lo stato degli snapshot valgono di più. Se questo service potesse fallire
 * verso l'alto, un canale mal configurato basterebbe a far ritentare
 * all'infinito lo stesso join a ogni esecuzione del cron.
 */
import { buildGoodbyeMessage, buildWelcomeMessage } from '../components/embeds/memberLifecycle.js';
import type { ApiUser } from '../discord/api.js';
import { avatarUrl } from '../discord/avatar.js';
import type { MessagePayload } from '../discord/payload.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('member-lifecycle');

/** Il minimo che serve da Discord: un canale su cui scrivere e un profilo utente. */
export interface LifecycleMessageGateway {
  sendMessage(channelId: string, payload: MessagePayload): Promise<string>;
  /** `GET /users/{id}`: funziona anche per chi non è più nella guild. */
  getUser(discordId: string): Promise<ApiUser | null>;
}

export interface LifecycleChannels {
  readonly welcome: string;
  readonly goodbye: string;
}

export interface WelcomeInput {
  readonly discordId: string;
  /**
   * `true` se l'account è un bot. Quando è `undefined` il dato viene chiesto
   * a Discord: un bot non deve ricevere il benvenuto.
   */
  readonly bot?: boolean | undefined;
  /**
   * Hash dell'avatar già noto dall'enumerazione del cron.
   * `undefined` = da risolvere, `null` = l'utente usa l'avatar di default.
   */
  readonly avatar?: string | null | undefined;
  /** Discriminator legacy, se noto: cambia quale avatar di default mostrare. */
  readonly discriminator?: string | undefined;
}

export interface GoodbyeInput {
  readonly discordId: string;
  /** Nome con cui il membro era conosciuto: dopo l'uscita non è più leggibile. */
  readonly displayName: string;
  readonly bot?: boolean | undefined;
}

export interface MemberLifecycleMessageService {
  /** @returns `true` se il messaggio è stato pubblicato davvero. */
  sendWelcome(input: WelcomeInput): Promise<boolean>;
  sendGoodbye(input: GoodbyeInput): Promise<boolean>;
}

export interface MemberLifecycleMessageDeps {
  readonly messages: LifecycleMessageGateway;
  readonly channels: LifecycleChannels;
}

export function createMemberLifecycleMessageService(
  deps: MemberLifecycleMessageDeps,
): MemberLifecycleMessageService {
  const { messages, channels } = deps;

  /**
   * Profilo utente, o `null` se non recuperabile.
   *
   * Un errore qui non deve costare il messaggio: si prosegue con l'avatar di
   * default, che è comunque meglio di un canale muto.
   */
  async function fetchUser(discordId: string): Promise<ApiUser | null> {
    try {
      return await messages.getUser(discordId);
    } catch (error) {
      log.warn({ err: error, discordId }, 'Profilo utente non recuperabile per il lifecycle');
      return null;
    }
  }

  async function publish(channelId: string, payload: MessagePayload): Promise<boolean> {
    await messages.sendMessage(channelId, payload);
    return true;
  }

  return {
    async sendWelcome(input: WelcomeInput): Promise<boolean> {
      try {
        // I bot entrano ed escono per manutenzione: annunciarli è rumore.
        if (input.bot === true) return false;

        // Si interroga Discord solo quando manca davvero qualcosa: nel caso
        // normale l'enumerazione del cron ha già portato avatar e flag bot.
        const needsLookup = input.bot === undefined || input.avatar === undefined;
        const user = needsLookup ? await fetchUser(input.discordId) : null;
        if (user?.bot === true) return false;

        const source = {
          id: input.discordId,
          avatar: user?.avatar ?? input.avatar ?? null,
          ...((user?.discriminator ?? input.discriminator)
            ? { discriminator: user?.discriminator ?? input.discriminator }
            : {}),
        };

        return await publish(
          channels.welcome,
          buildWelcomeMessage({ discordId: input.discordId, avatarUrl: avatarUrl(source) }),
        );
      } catch (error) {
        log.error(
          { err: error, discordId: input.discordId, channelId: channels.welcome },
          'Messaggio di benvenuto non inviato: la riconciliazione prosegue',
        );
        return false;
      }
    },

    async sendGoodbye(input: GoodbyeInput): Promise<boolean> {
      try {
        if (input.bot === true) return false;

        // L'utente non è più nella guild: l'unica fonte per avatar e flag bot
        // è l'endpoint globale `/users/{id}`.
        const user = await fetchUser(input.discordId);
        if (user?.bot === true) return false;

        const source = {
          id: input.discordId,
          avatar: user?.avatar ?? null,
          ...(user?.discriminator === undefined ? {} : { discriminator: user.discriminator }),
        };

        return await publish(
          channels.goodbye,
          buildGoodbyeMessage({
            discordId: input.discordId,
            displayName: input.displayName,
            avatarUrl: avatarUrl(source),
          }),
        );
      } catch (error) {
        log.error(
          { err: error, discordId: input.discordId, channelId: channels.goodbye },
          'Messaggio di addio non inviato: la riconciliazione prosegue',
        );
        return false;
      }
    },
  };
}
