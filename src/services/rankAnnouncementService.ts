/**
 * PUT ON / PUT OFF — annuncio pubblico dei cambi di rank.
 *
 * Unico responsabile della PUBBLICAZIONE di un cambio di rank. `MemberService`
 * non costruisce embed e non conosce canali: chiama questo service e prosegue.
 *
 * BEST-EFFORT PER CONTRATTO: nessun metodo di questo service lancia mai.
 * L'annuncio non e' il dato autorevole — lo sono il database, i ruoli
 * Discord, `MemberHistory` e l'audit, che a questo punto sono gia' tutti
 * scritti. Un canale mal configurato non deve poter annullare una promozione
 * gia' applicata, ne' far fallire l'interaction dell'operatore.
 *
 * PERCHE' NON NEI COMMAND HANDLER. L'annuncio e' agganciato all'operazione di
 * dominio, non al punto d'ingresso: slash command, bottoni della member card e
 * control panel passano tutti dallo stesso `changeRank`, quindi producono lo
 * stesso annuncio senza che nessuno debba ricordarsi di inviarlo.
 */
import type { MemberRank } from '../generated/prisma/enums.js';
import { compareRanks } from '../config/constants.js';
import {
  buildRankAnnouncement,
  type RankChangeDirection,
} from '../components/embeds/rankAnnouncement.js';
import type { MessagePayload } from '../discord/payload.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('put-on-off');

export type { RankChangeDirection };

/** Il minimo che serve da Discord: un canale su cui scrivere. */
export interface RankAnnouncementGateway {
  sendMessage(channelId: string, payload: MessagePayload): Promise<string>;
}

export interface RankAnnouncementInput {
  readonly memberDiscordId: string;
  readonly actorDiscordId: string;
  readonly fromRank: MemberRank;
  readonly toRank: MemberRank;
  readonly reason?: string | null | undefined;
  /**
   * Direzione gia' calcolata dal chiamante. Se omessa la deduce da
   * `RANK_ORDER`: e' il caso normale.
   */
  readonly direction?: RankChangeDirection | undefined;
}

export interface RankAnnouncementService {
  /**
   * Pubblica l'annuncio del cambio di rank.
   *
   * @returns la direzione annunciata, oppure `null` se non e' stato
   *   pubblicato nulla — rank invariato, oppure invio fallito.
   */
  announceRankChange(input: RankAnnouncementInput): Promise<RankChangeDirection | null>;
}

/**
 * Direzione di un cambio di rank secondo `RANK_ORDER`.
 *
 * Mai un confronto fra stringhe: `'BIG' > 'BIG_HOMIE'` sarebbe vero in ordine
 * alfabetico e falso nella gerarchia.
 *
 * @returns `null` se i due rank coincidono: non c'e' niente da annunciare.
 */
export function directionOf(fromRank: MemberRank, toRank: MemberRank): RankChangeDirection | null {
  const delta = compareRanks(toRank, fromRank);
  if (delta === 0) return null;
  return delta > 0 ? 'PUT_ON' : 'PUT_OFF';
}

export interface RankAnnouncementDeps {
  readonly messages: RankAnnouncementGateway;
  /** Canale pubblico degli annunci: `CHANNEL_PUT_ON_OFF_ID`. */
  readonly channelId: string;
}

export function createRankAnnouncementService(deps: RankAnnouncementDeps): RankAnnouncementService {
  const { messages, channelId } = deps;

  return {
    async announceRankChange(input: RankAnnouncementInput): Promise<RankChangeDirection | null> {
      const direction = input.direction ?? directionOf(input.fromRank, input.toRank);
      // Rank invariato: nessun annuncio. Non e' un errore.
      if (direction === null) return null;

      try {
        await messages.sendMessage(
          channelId,
          buildRankAnnouncement({
            memberDiscordId: input.memberDiscordId,
            actorDiscordId: input.actorDiscordId,
            fromRank: input.fromRank,
            toRank: input.toRank,
            direction,
            reason: input.reason,
          }),
        );
        return direction;
      } catch (error) {
        // Si registra e basta: il cambio di rank a monte resta valido, e
        // ritentare qui rischierebbe di pubblicare due volte lo stesso
        // annuncio per una singola mutazione.
        log.error(
          {
            err: error,
            channelId,
            direction,
            discordId: input.memberDiscordId,
            fromRank: input.fromRank,
            toRank: input.toRank,
          },
          'Annuncio Put On/Put Off non pubblicato: il cambio di rank resta valido',
        );
        return null;
      }
    },
  };
}
