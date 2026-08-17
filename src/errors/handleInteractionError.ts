/**
 * Gestione centralizzata degli errori di interaction.
 *
 * All'utente arriva un messaggio comprensibile con un codice; lo stack trace
 * e il contesto restano nei log. Nessun dettaglio interno viene mai esposto
 * su Discord.
 */
import type { InteractionContext } from '../http/interactionContext.js';
import { AppError, ERROR_CODE, isAppError } from './AppError.js';
import { errorEmbed } from '../components/embeds/base.js';
import { createLogger } from '../utils/logger.js';
import { respond } from '../utils/respond.js';

const log = createLogger('interaction-error');

export interface ErrorContext {
  /** Es. `/member promote`, `button:member:promote`. */
  readonly operation: string;
  readonly actorDiscordId?: string | undefined;
  readonly targetDiscordId?: string | undefined;
}

export async function handleInteractionError(
  interaction: InteractionContext,
  error: unknown,
  context: ErrorContext,
): Promise<void> {
  const appError: AppError = isAppError(error)
    ? error
    : new AppError(
        ERROR_CODE.INTERNAL,
        'Si è verificato un errore imprevisto durante l’operazione.',
        { cause: error },
      );

  const logPayload = {
    err: error,
    code: appError.code,
    operation: context.operation,
    actor: context.actorDiscordId,
    target: context.targetDiscordId,
    ...appError.context,
  };

  // Gli errori attesi sono informazione, non guasti: non sporcano il livello
  // `error` con rumore che nasconderebbe i problemi veri.
  if (isAppError(error)) {
    log.info(logPayload, 'Operazione rifiutata');
  } else {
    log.error(logPayload, 'Errore non gestito in una interaction');
  }

  const embed = errorEmbed('Operazione non completata', appError.message).setFooter({
    text: `Codice: ${appError.code}`,
  });

  if (!isAppError(error)) {
    embed.setDescription(
      `${appError.message}\n\nSe il problema si ripete contatta un OG indicando il codice qui sotto.`,
    );
  }

  await respond(interaction, { embeds: [embed], ephemeral: true });
}
