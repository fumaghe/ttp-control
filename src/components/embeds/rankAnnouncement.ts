/**
 * Embed pubblici PUT ON / PUT OFF: la gang vede salire e scendere i propri.
 *
 * Solo PRESENTAZIONE. Non decide se un annuncio vada pubblicato — quella e'
 * una decisione di `RankAnnouncementService` — e non parla mai con Discord.
 * Cosi' il testo si verifica senza rete e senza database.
 *
 * DISTINZIONE DI DOMINIO: questi embed raccontano il CAMBIO DI RANK di un
 * membro che e' GIA' TTP. L'ingresso nella gang non e' un Put On: chi entra a
 * Resident non e' stato "messo su" da nessuna parte, e ha il proprio annuncio
 * altrove.
 */
import type { EmbedBuilder } from '@discordjs/builders';
import type { MemberRank } from '../../generated/prisma/enums.js';
import { EMBED_COLOR, GANG_NAME, RANK_LABEL } from '../../config/constants.js';
import type { MessagePayload } from '../../discord/payload.js';
import { brandEmbed, escapeMarkdown, mention, truncate } from './base.js';

/**
 * Direzione del cambio di rank.
 *
 * Non si deduce MAI confrontando i nomi dei rank: la calcola
 * `RankAnnouncementService` con `compareRanks`, cioe' con `RANK_ORDER`.
 */
export type RankChangeDirection = 'PUT_ON' | 'PUT_OFF';

export interface RankAnnouncementInput {
  readonly memberDiscordId: string;
  /** Chi ha eseguito l'operazione. */
  readonly actorDiscordId: string;
  readonly fromRank: MemberRank;
  readonly toRank: MemberRank;
  readonly direction: RankChangeDirection;
  readonly reason?: string | null | undefined;
}

interface DirectionStyle {
  readonly title: string;
  readonly sentence: string;
  /** Etichetta del campo che attribuisce l'operazione all'attore. */
  readonly actorField: string;
  readonly color: number;
}

const STYLE: Readonly<Record<RankChangeDirection, DirectionStyle>> = {
  PUT_ON: {
    title: '🔥 PUT ON',
    sentence: 'è stato messo su.',
    actorField: 'Promosso da',
    color: EMBED_COLOR.success,
  },
  PUT_OFF: {
    // Volutamente sobrio: un Put Off e' una decisione della Leadership, non
    // una gogna. Colore d'avviso, non di allarme.
    title: '📉 PUT OFF',
    sentence: 'è stato messo giù.',
    actorField: 'Gestito da',
    color: EMBED_COLOR.warning,
  },
};

/**
 * La scaletta verticale `da → a`, il cuore visivo dell'annuncio.
 *
 * Le etichette arrivano da `RANK_LABEL`, quindi un rank aggiunto alla
 * gerarchia compare qui senza toccare questo file.
 */
function rankLadder(fromRank: MemberRank, toRank: MemberRank): string {
  return [RANK_LABEL[fromRank], '⠀⠀⠀⠀⠀↓', `**${RANK_LABEL[toRank]}**`].join('\n');
}

/** Annuncio pubblico di un cambio di rank, in entrambe le direzioni. */
export function buildRankAnnouncement(input: RankAnnouncementInput): MessagePayload {
  const style = STYLE[input.direction];

  const embed: EmbedBuilder = brandEmbed(style.title)
    .setColor(style.color)
    .setDescription(
      [
        `${mention(input.memberDiscordId)} ${style.sentence}`,
        '',
        rankLadder(input.fromRank, input.toRank),
      ].join('\n'),
    )
    .addFields({
      name: style.actorField,
      value: mention(input.actorDiscordId),
      inline: true,
    });

  // La motivazione arriva da un operatore: va neutralizzata prima di finire
  // in un canale pubblico.
  if (input.reason) {
    embed.addFields({
      name: 'Motivo',
      value: truncate(escapeMarkdown(input.reason)),
      inline: false,
    });
  }

  embed.setFooter({ text: GANG_NAME });

  return { embeds: [embed] };
}
