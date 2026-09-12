/**
 * Riconoscimento delle violazioni di vincolo univoco.
 *
 * Alcuni vincoli unique del progetto non sono guasti: sono il MECCANISMO con
 * cui il database impedisce un doppione quando due scritture concorrenti
 * partono dallo stesso stato — due isolate Cloudflare, o un comando e il cron
 * di riconciliazione. `memberMutex` non può coprire quel caso, perché vive
 * nella memoria di un singolo isolate.
 *
 * In quelle situazioni la reazione corretta è rileggere la riga che è stata
 * creata e proseguire da quella, NON propagare un errore che il chiamante
 * interpreterebbe come fallimento permanente. Questo modulo serve solo a
 * distinguere quel caso dagli errori veri.
 *
 * Il codice `P2002` è quello di Prisma per "Unique constraint failed"; il
 * fallback sul testo copre le implementazioni in memoria usate dai test, che
 * riproducono i vincoli ma non i codici d'errore di Prisma.
 */

/** L'errore è una violazione di vincolo univoco (Prisma `P2002`). */
export function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;

  const code = (error as { code?: unknown }).code;
  if (code === 'P2002') return true;

  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && /unique constraint/i.test(message);
}
