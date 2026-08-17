/**
 * Pannelli persistenti.
 *
 * Il problema che risolve: senza persistenza, ogni restart del bot
 * ripubblicherebbe il verify panel, lasciando nel canale una collezione di
 * pannelli morti. Qui si tiene traccia del `messageId`, si prova a
 * modificare quello esistente, e si ricrea solo se e' stato cancellato.
 */
import { type BaseMessageOptions, DiscordAPIError, RESTJSONErrorCodes } from 'discord.js';
import type { PanelType } from '../generated/prisma/enums.js';
import type { PersistentPanelRepository } from '../repositories/types.js';
import { AppError, ERROR_CODE } from '../errors/AppError.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('panels');

/** Operazioni sui messaggi, isolate per non legare il service a discord.js. */
export interface PanelMessageGateway {
  /** @returns `false` se il messaggio non esiste piu'. */
  edit(channelId: string, messageId: string, payload: BaseMessageOptions): Promise<boolean>;
  send(channelId: string, payload: BaseMessageOptions): Promise<string>;
}

export interface PanelSyncResult {
  readonly messageId: string;
  readonly action: 'updated' | 'created';
}

export interface PanelService {
  /**
   * Garantisce che esista uno e un solo pannello di quel tipo nel canale.
   * Aggiorna quello registrato, oppure lo ricrea se e' sparito.
   */
  publish(input: {
    panelType: PanelType;
    channelId: string;
    payload: BaseMessageOptions;
  }): Promise<PanelSyncResult>;

  /** Aggiorna un pannello gia' pubblicato, senza crearlo se non esiste. */
  refresh(input: {
    panelType: PanelType;
    payload: BaseMessageOptions;
  }): Promise<PanelSyncResult | null>;
}

export function createPanelService(deps: {
  panels: PersistentPanelRepository;
  messages: PanelMessageGateway;
  guildId: string;
}): PanelService {
  const { panels, messages, guildId } = deps;

  return {
    async publish(input): Promise<PanelSyncResult> {
      const existing = await panels.find(guildId, input.panelType);

      if (existing) {
        try {
          const edited = await messages.edit(existing.channelId, existing.messageId, input.payload);
          if (edited && existing.channelId === input.channelId) {
            return { messageId: existing.messageId, action: 'updated' };
          }
        } catch (error) {
          // Un messaggio cancellato a mano non e' un errore: si ricrea.
          if (
            !(error instanceof DiscordAPIError) ||
            error.code !== RESTJSONErrorCodes.UnknownMessage
          ) {
            log.warn(
              { err: error, panelType: input.panelType },
              'Aggiornamento del pannello fallito: verrà ricreato',
            );
          }
        }
      }

      let messageId: string;
      try {
        messageId = await messages.send(input.channelId, input.payload);
      } catch (error) {
        throw new AppError(
          ERROR_CODE.CHANNEL_NOT_FOUND,
          'Non è stato possibile pubblicare il pannello nel canale indicato. Controlla che il bot possa scrivere lì.',
          { cause: error, context: { channelId: input.channelId } },
        );
      }

      await panels.save({
        guildId,
        panelType: input.panelType,
        channelId: input.channelId,
        messageId,
      });

      return { messageId, action: 'created' };
    },

    async refresh(input): Promise<PanelSyncResult | null> {
      const existing = await panels.find(guildId, input.panelType);
      if (!existing) return null;

      try {
        const edited = await messages.edit(existing.channelId, existing.messageId, input.payload);
        if (!edited) {
          // Sparito: togliamo il record, cosi' il prossimo `publish` ricrea.
          await panels.delete(guildId, input.panelType);
          return null;
        }
        return { messageId: existing.messageId, action: 'updated' };
      } catch (error) {
        log.warn({ err: error, panelType: input.panelType }, 'Refresh del pannello fallito');
        return null;
      }
    },
  };
}
