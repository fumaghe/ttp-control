/**
 * Registro di comandi e handler.
 *
 * Registrazione esplicita invece di scansione della cartella: il bundle di
 * produzione resta prevedibile, gli errori emergono a compile time e non c'è
 * modo di caricare per sbaglio un file che non doveva essere un handler.
 */
import { applyCommand } from '../commands/apply.js';
import { blacklistCommand } from '../commands/blacklist.js';
import { communityCommand } from '../commands/community.js';
import { memberCommand } from '../commands/member.js';
import { panelCommand } from '../commands/panel.js';
import { pingCommand } from '../commands/ping.js';
import { rosterCommand } from '../commands/roster.js';
import { setupCommand } from '../commands/setup.js';
import { systemCommand } from '../commands/system.js';

import {
  applicationButtonHandler,
  applicationModalHandler,
} from './applications/applicationHandlers.js';
import { memberButtonHandler, memberModalHandler } from './members/memberHandlers.js';
import {
  panelButtonHandler,
  panelModalHandler,
  rosterButtonHandler,
} from './panels/panelHandlers.js';
import { verifyButtonHandler, verifyModalHandler } from './verify/verifyHandlers.js';

import type { ComponentHandler, ModalHandler, SlashCommand } from '../types/command.js';

export const commands: readonly SlashCommand[] = [
  pingCommand,
  setupCommand,
  applyCommand,
  memberCommand,
  rosterCommand,
  communityCommand,
  blacklistCommand,
  panelCommand,
  systemCommand,
];

export const componentHandlers: readonly ComponentHandler[] = [
  verifyButtonHandler,
  applicationButtonHandler,
  memberButtonHandler,
  panelButtonHandler,
  rosterButtonHandler,
];

export const modalHandlers: readonly ModalHandler[] = [
  verifyModalHandler,
  applicationModalHandler,
  memberModalHandler,
  panelModalHandler,
];

export const commandsByName = new Map(commands.map((command) => [command.name, command]));
export const componentsByNamespace = new Map(
  componentHandlers.map((handler) => [handler.namespace, handler]),
);
export const modalsByNamespace = new Map(
  modalHandlers.map((handler) => [handler.namespace, handler]),
);

/** Payload da inviare all'API per la registrazione dei comandi. */
export function commandPayloads() {
  return commands.map((command) => command.data);
}
