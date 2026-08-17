/**
 * Validazione degli input provenienti dal client Discord.
 *
 * Nulla di cio' che arriva da un modal o da un `customId` e' affidabile:
 * ogni valore va normalizzato e validato lato server prima di toccare il
 * database o i ruoli.
 */
import { ValidationError } from '../errors/AppError.js';

export interface TextFieldRules {
  readonly label: string;
  readonly min: number;
  readonly max: number;
  /** Se presente, il valore normalizzato deve corrispondere. */
  readonly pattern?: RegExp;
  readonly patternHint?: string;
}

/**
 * Normalizza uno spazio bianco disordinato: niente spazi doppi, niente
 * caratteri di controllo, niente spazi ai bordi.
 */
export function normalizeWhitespace(value: string): string {
  return value
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** Valida e normalizza un campo di testo. @throws ValidationError */
export function validateText(raw: string | null | undefined, rules: TextFieldRules): string {
  const value = normalizeWhitespace(raw ?? '');

  if (value.length < rules.min) {
    throw new ValidationError(
      rules.min === 1
        ? `Il campo **${rules.label}** è obbligatorio.`
        : `Il campo **${rules.label}** deve contenere almeno ${rules.min} caratteri.`,
      { context: { field: rules.label } },
    );
  }

  if (value.length > rules.max) {
    throw new ValidationError(
      `Il campo **${rules.label}** non può superare ${rules.max} caratteri (ne hai inseriti ${value.length}).`,
      { context: { field: rules.label } },
    );
  }

  if (rules.pattern && !rules.pattern.test(value)) {
    throw new ValidationError(
      `Il campo **${rules.label}** non è in un formato valido.${
        rules.patternHint ? ` ${rules.patternHint}` : ''
      }`,
      { context: { field: rules.label } },
    );
  }

  return value;
}

/** Nome IC: lettere, spazi, apostrofi, trattini e accenti. */
const IC_NAME_PATTERN = /^[\p{L}][\p{L}\s'’-]*$/u;

export interface VerificationFormInput {
  readonly rpName: string;
  readonly oocName: string;
}

/**
 * Valida il modal di verifica per intero.
 */
export function validateVerificationForm(raw: {
  rpName: string | null;
  oocName: string | null;
}): VerificationFormInput {
  const problems: string[] = [];

  const collect = <T>(run: () => T): T | undefined => {
    try {
      return run();
    } catch (error) {
      if (error instanceof ValidationError) {
        problems.push(error.message);
        return undefined;
      }

      throw error;
    }
  };

  const rpName = collect(() =>
    validateText(raw.rpName, {
      label: 'Nome IC',
      min: 2,
      max: 64,
      pattern: IC_NAME_PATTERN,
      patternHint: 'Sono ammesse solo lettere, spazi, apostrofi e trattini.',
    }),
  );

  const oocName = collect(() =>
    validateText(raw.oocName, {
      label: 'Nome OOC',
      min: 2,
      max: 64,
    }),
  );

  if (problems.length > 0 || rpName === undefined || oocName === undefined) {
    throw new ValidationError(problems.join('\n'), {
      context: { fields: problems.length },
    });
  }

  return {
    rpName,
    oocName,
  };
}

/** Motivazione di un'azione amministrativa. */
export function validateReason(raw: string | null | undefined, label = 'Motivazione'): string {
  return validateText(raw, { label, min: 3, max: 500 });
}

/** Motivazione facoltativa: `null` se vuota, validata se presente. */
export function validateOptionalReason(
  raw: string | null | undefined,
  label = 'Motivazione',
): string | null {
  const value = normalizeWhitespace(raw ?? '');

  if (value === '') return null;

  return validateText(value, {
    label,
    min: 3,
    max: 500,
  });
}

/** Note libere della Leadership. */
export function validateOptionalNotes(raw: string | null | undefined): string | null {
  const value = normalizeWhitespace(raw ?? '');

  if (value === '') return null;

  return validateText(value, {
    label: 'Note',
    min: 1,
    max: 1000,
  });
}

const SNOWFLAKE_PATTERN = /^\d{17,20}$/;

/** Uno snowflake Discord arrivato da un `customId` o da un'opzione. */
export function validateSnowflake(raw: string | null | undefined, label = 'ID utente'): string {
  const value = (raw ?? '').trim();

  if (!SNOWFLAKE_PATTERN.test(value)) {
    throw new ValidationError(`**${label}** non è un ID Discord valido.`);
  }

  return value;
}

export function isSnowflake(value: string): boolean {
  return SNOWFLAKE_PATTERN.test(value);
}