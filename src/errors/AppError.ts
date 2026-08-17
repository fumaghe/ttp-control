/**
 * Errori applicativi tipizzati.
 *
 * Ogni errore porta un CODICE stabile mostrabile all'utente, e un messaggio
 * gia' scritto per essere letto da un umano nel Discord. Lo stack trace resta
 * nei log: all'utente arriva solo codice + messaggio.
 */

/** Codici stabili: non rinominarli, finiscono nelle risposte agli utenti. */
export const ERROR_CODE = {
  UNAUTHORIZED: 'UNAUTHORIZED',
  NOT_IN_GUILD: 'NOT_IN_GUILD',
  WRONG_GUILD: 'WRONG_GUILD',
  TARGET_NOT_FOUND: 'TARGET_NOT_FOUND',
  TARGET_LEFT_GUILD: 'TARGET_LEFT_GUILD',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  BLACKLISTED: 'BLACKLISTED',
  ALREADY_VERIFIED: 'ALREADY_VERIFIED',
  NOT_VERIFIED: 'NOT_VERIFIED',
  ALREADY_TTP: 'ALREADY_TTP',
  NOT_TTP: 'NOT_TTP',
  APPLICATION_EXISTS: 'APPLICATION_EXISTS',
  APPLICATION_NOT_PENDING: 'APPLICATION_NOT_PENDING',
  APPLICATION_NOT_FOUND: 'APPLICATION_NOT_FOUND',
  RANK_AT_MAXIMUM: 'RANK_AT_MAXIMUM',
  RANK_AT_MINIMUM: 'RANK_AT_MINIMUM',
  RANK_UNCHANGED: 'RANK_UNCHANGED',
  STATE_CHANGED: 'STATE_CHANGED',
  OPERATION_IN_PROGRESS: 'OPERATION_IN_PROGRESS',
  ROLE_ASSIGNMENT_FAILED: 'ROLE_ASSIGNMENT_FAILED',
  ROLE_HIERARCHY: 'ROLE_HIERARCHY',
  ROLE_NOT_FOUND: 'ROLE_NOT_FOUND',
  CHANNEL_NOT_FOUND: 'CHANNEL_NOT_FOUND',
  DATABASE_ERROR: 'DATABASE_ERROR',
  DISCORD_ERROR: 'DISCORD_ERROR',
  INVALID_INTERACTION: 'INVALID_INTERACTION',
  NOT_BLACKLISTED: 'NOT_BLACKLISTED',
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCode = (typeof ERROR_CODE)[keyof typeof ERROR_CODE];

export interface AppErrorOptions {
  /** Contesto strutturato per i log. Non deve contenere secret. */
  readonly context?: Record<string, unknown>;
  readonly cause?: unknown;
}

/**
 * Errore atteso, con una causa di dominio nota.
 *
 * Distinzione importante: un `AppError` e' una situazione prevista (l'utente
 * e' gia' verificato, il rank e' al massimo, ...) e viene mostrato all'utente
 * cosi' com'e'. Qualsiasi altra eccezione e' un bug o un guasto e diventa un
 * messaggio generico con codice `INTERNAL`.
 */
export class AppError extends Error {
  public readonly code: ErrorCode;

  public readonly context: Record<string, unknown>;

  /** `true` se il messaggio e' pensato per essere mostrato all'utente. */
  public readonly isUserFacing = true;

  public constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.context = options.context ?? {};
  }
}

/** L'attore non ha i permessi per l'operazione richiesta. */
export class AuthorizationError extends AppError {
  public constructor(message: string, options: AppErrorOptions = {}) {
    super(ERROR_CODE.UNAUTHORIZED, message, options);
    this.name = 'AuthorizationError';
  }
}

/** L'input non ha superato la validazione. */
export class ValidationError extends AppError {
  public constructor(message: string, options: AppErrorOptions = {}) {
    super(ERROR_CODE.VALIDATION_FAILED, message, options);
    this.name = 'ValidationError';
  }
}

/**
 * Lo stato e' cambiato tra la lettura e la scrittura (locking ottimistico):
 * tipicamente due operatori che agiscono sullo stesso membro insieme.
 */
export class ConcurrencyError extends AppError {
  public constructor(message: string, options: AppErrorOptions = {}) {
    super(ERROR_CODE.STATE_CHANGED, message, options);
    this.name = 'ConcurrencyError';
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
