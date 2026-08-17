/**
 * Embed di ciclo di vita del membro Discord: benvenuto e addio.
 *
 * Solo PRESENTAZIONE. Non decide se un messaggio vada inviato — quella e' una
 * decisione di `MemberLifecycleMessageService` — e non parla mai con Discord.
 * Cosi' il testo si verifica senza rete e senza database.
 *
 * DISTINZIONE DI DOMINIO: qui si parla esclusivamente del SERVER DISCORD.
 * Entrare nel Discord non e' entrare in TTP, e lasciarlo non e' lasciare la
 * gang: nessuno dei due embed deve suggerire il contrario.
 */
import { EmbedBuilder } from '@discordjs/builders';
import { EMBED_COLOR, GANG_NAME } from '../../config/constants.js';
import { GOODBYE_PHRASES, WELCOME_PHRASES } from '../../config/lifecyclePhrases.js';
import type { MessagePayload } from '../../discord/payload.js';
import { pickRandom } from '../../utils/random.js';
import { brandEmbed, escapeMarkdown, mention } from './base.js';

export interface WelcomeEmbedInput {
  readonly discordId: string;
  /** URL gia' risolto: l'embed non sa nulla del CDN Discord. */
  readonly avatarUrl: string;
  /** Iniettabile nei test, cosi' l'asserzione non dipende dal caso. */
  readonly phrase?: string;
}

export interface GoodbyeEmbedInput {
  readonly discordId: string;
  /** Nome mostrato al momento dell'uscita: l'utente non e' piu' menzionabile. */
  readonly displayName: string;
  readonly avatarUrl: string;
  readonly phrase?: string;
}

/**
 * Benvenuto pubblico a un nuovo membro del Discord.
 *
 * L'avatar e' `setImage` e non `setThumbnail`: deve occupare la larghezza
 * dell'embed, non l'angolo.
 */
export function buildWelcomeMessage(input: WelcomeEmbedInput): MessagePayload {
  const phrase = input.phrase ?? pickRandom(WELCOME_PHRASES);

  const embed = brandEmbed('WELCOME TO THE EMPIRE')
    .setDescription(
      [
        `👋 Benvenuto ${mention(input.discordId)}`,
        '',
        phrase,
        '',
        'Ora fai un giro nel server e completa la verifica per accedere alla community.',
      ].join('\n'),
    )
    .setImage(input.avatarUrl)
    .setFooter({ text: GANG_NAME });

  return { embeds: [embed] };
}

/**
 * Saluto a chi ha lasciato il SERVER Discord.
 *
 * L'ID finisce nel footer perche' la menzione di un utente uscito non e' piu'
 * affidabile: Discord la renderizza come `<@id>` grezzo appena la cache del
 * client non ha piu' il profilo.
 */
export function buildGoodbyeMessage(input: GoodbyeEmbedInput): MessagePayload {
  const phrase = input.phrase ?? pickRandom(GOODBYE_PHRASES);

  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR.neutral)
    .setTimestamp(new Date())
    .setAuthor({ name: GANG_NAME })
    .setTitle('LEFT THE EMPIRE')
    .setDescription(
      [`🚪 **${escapeMarkdown(input.displayName)}** ha lasciato il server.`, '', phrase].join('\n'),
    )
    .setImage(input.avatarUrl)
    .setFooter({ text: `${GANG_NAME} • ID ${input.discordId}` });

  return { embeds: [embed] };
}
