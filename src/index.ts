/**
 * TTP Control — entry point.
 *
 * PHASE 0 PLACEHOLDER.
 * This file only proves the toolchain (TypeScript + ESM + tsx + build) works
 * end to end. Phase 1 replaces it with the real bootstrap:
 *   env validation -> logger -> database connection -> Discord client ->
 *   event loader -> command loader -> login -> graceful shutdown.
 */

import { APP_BANNER } from './utils/constants.js';

process.stdout.write(`${APP_BANNER} — toolchain OK (phase 0 placeholder)\n`);
