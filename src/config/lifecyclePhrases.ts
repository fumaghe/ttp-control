/**
 * Frasi dei messaggi di benvenuto e di addio.
 *
 * Sono TESTO, non logica: stanno qui perche' si riscrivono senza toccare
 * l'embed che le mostra ne' il service che le invia. Tono GTA RP / street,
 * coerente con il brand dell'Impero: mai offensive, mai rivolte alla persona.
 *
 * L'invito alla verifica NON e' in queste frasi: e' fisso nell'embed, cosi'
 * ogni benvenuto lo contiene sempre qualunque frase venga estratta.
 */

/** Almeno 8: bastano a non far sembrare il bot un disco rotto. */
export const WELCOME_PHRASES = [
  'Un nuovo volto è appena entrato nell’Impero.',
  'Le strade hanno un nuovo nome da ricordare.',
  'Qualcuno ha appena varcato le porte dell’Impero.',
  'Nuovo arrivo. Rispetto, presenza e sangue freddo.',
  'Le strade si fanno un po’ più affollate.',
  'Benvenuto dove la reputazione conta più di tutto il resto.',
  'L’Impero ha appena accolto un nuovo volto.',
  'Una nuova storia comincia da queste strade.',
  'Il quartiere ha un abitante in più.',
  'Le luci della città si accendono su qualcuno di nuovo.',
] as const;

/**
 * Frasi per chi lascia il Discord.
 *
 * Nessuna parla della gang: uscire dal server non e' lasciare TTP, e il
 * messaggio pubblico non deve suggerire il contrario.
 */
export const GOODBYE_PHRASES = [
  'Ha deciso di prendere un’altra strada.',
  'Una presenza in meno tra le nostre strade.',
  'Le porte dell’Impero si sono chiuse alle sue spalle.',
  'Un altro nome lascia la città.',
  'Le strade cambiano, le storie restano.',
  'Ha lasciato il server e proseguito per la sua strada.',
  'Un volto in meno tra le vie dell’Impero.',
  'Ogni arrivo ha anche una partenza.',
  'La città continua a girare, comunque vada.',
  'Le luci si spengono su un altro capitolo.',
] as const;
