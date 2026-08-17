/**
 * Application-wide constants.
 *
 * Anything here must be safe to log and safe to commit: no IDs, no secrets.
 */

export const APP_NAME = 'TTP Control';

export const APP_VERSION = '0.1.0';

/** Shown on boot and in the `/setup` system check header. */
export const APP_BANNER = `${APP_NAME} v${APP_VERSION}`;
