/**
 * TTP CONTROL — entrypoint.
 *
 * PHASE 0 (bootstrap): questo file esiste solo per validare la toolchain
 * (TypeScript -> build -> run). Non contiene ancora logica Discord.
 *
 * PHASE 1 sostituira' interamente questo contenuto con:
 *   - validazione env tipizzata      (src/config/env.ts)
 *   - connessione database           (src/database/prisma.ts)
 *   - Discord client + intents       (src/client/createClient.ts)
 *   - event loader / command loader  (src/events, src/commands)
 *   - logger, error handling, graceful shutdown
 */

import { BOT_NAME, BOT_VERSION } from './config/constants.js';

// eslint-disable-next-line no-console
console.log(`${BOT_NAME} v${BOT_VERSION} — bootstrap OK (Phase 0)`);
