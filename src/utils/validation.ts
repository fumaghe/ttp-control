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
  return (
    value
      // I caratteri di controllo (inclusi quelli invisibili incollati da
      // altre applicazioni) diventano spazi, poi vengono collassati.
      .replace(/\p{Cc}/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim()
  );
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

/** Un nome o cognome IC: lettere, spazi, apostrofi, trattini e accenti. */
const NAME_PATTERN = /^[\p{L}][\p{L}\s'’-]*$/u;

/** ID cittadino: alfanumerico, cosi' regge le convenzioni di server diversi. */
const CITIZEN_ID_PATTERN = /^[A-Za-z0-9-]{1,16}$/;

/** Telefono IC: cifre, spazi, trattini e un eventuale prefisso. */
const PHONE_PATTERN = /^[+]?[\d\s-]{3,20}$/;

export interface VerificationFormInput {
  readonly rpName: string;
  readonly rpSurname: string;
  readonly citizenId: string;
  readonly phone: string;
  readonly referral: string;
}

/**
 * Valida il modal di verifica per intero.
 *
 * Raccoglie tutti gli errori invece di fermarsi al primo: l'utente non deve
 * riaprire il modal cinque volte per scoprire cinque problemi.
 */
export function validateVerificationForm(raw: {
  rpName: string | null;
  rpSurname: string | null;
  citizenId: string | null;
  phone: string | null;
  referral: string | null;
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
      max: 32,
      pattern: NAME_PATTERN,
      patternHint: 'Sono ammesse solo lettere, spazi, apostrofi e trattini.',
    }),
  );

  const rpSurname = collect(() =>
    validateText(raw.rpSurname, {
      label: 'Cognome IC',
      min: 2,
      max: 32,
      pattern: NAME_PATTERN,
      patternHint: 'Sono ammesse solo lettere, spazi, apostrofi e trattini.',
    }),
  );

  const citizenId = collect(() =>
    validateText(raw.citizenId, {
      label: 'ID cittadino',
      min: 1,
      max: 16,
      pattern: CITIZEN_ID_PATTERN,
      patternHint: 'Sono ammessi solo lettere, numeri e trattini.',
    }),
  );

  const phone = collect(() =>
    validateText(raw.phone, {
      label: 'Telefono IC',
      min: 3,
      max: 20,
      pattern: PHONE_PATTERN,
      patternHint: 'Sono ammessi solo numeri, spazi, trattini ed eventualmente un “+”.',
    }),
  );

  const referral = collect(() =>
    validateText(raw.referral, { label: 'Come conosci i TTP?', min: 3, max: 300 }),
  );

  // Un campo `undefined` significa che il suo `collect` ha fallito, quindi
  // `problems` non e' vuoto: il controllo copre entrambe le condizioni e
  // restringe i tipi senza bisogno di asserzioni.
  if (
    problems.length > 0 ||
    rpName === undefined ||
    rpSurname === undefined ||
    citizenId === undefined ||
    phone === undefined ||
    referral === undefined
  ) {
    throw new ValidationError(problems.join('\n'), { context: { fields: problems.length } });
  }

  return { rpName, rpSurname, citizenId, phone, referral };
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
  return validateText(value, { label, min: 3, max: 500 });
}

/** Note libere della Leadership. */
export function validateOptionalNotes(raw: string | null | undefined): string | null {
  const value = normalizeWhitespace(raw ?? '');
  if (value === '') return null;
  return validateText(value, { label: 'Note', min: 1, max: 1000 });
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
