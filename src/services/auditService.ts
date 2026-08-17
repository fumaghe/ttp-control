/**
 * Audit system.
 *
 * Regola non negoziabile: un'operazione gia' andata a buon fine NON deve
 * fallire perche' non si e' potuto scrivere il log su Discord. La scrittura
 * a database e' parte dell'operazione; l'invio del messaggio nel canale e'
 * best-effort, e un suo errore viene registrato ma non propagato.
 */
import type { AuditAction } from '../generated/prisma/enums.js';
import type { AuditInput, AuditRepository, JsonObject } from '../repositories/types.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('audit');

/** Destinazione dei log su Discord. Implementata dal layer Discord. */
export interface AuditSink {
  /** Canale di audit amministrativo generale. */
  sendAudit(entry: AuditEntry): Promise<void>;
  /** Canale dedicato agli eventi di membership. */
  sendMemberLog(entry: AuditEntry): Promise<void>;
  /** Canale dedicato alla blacklist. */
  sendBlacklistLog(entry: AuditEntry): Promise<void>;
}

export interface AuditEntry extends AuditInput {
  readonly action: AuditAction;
}

/** Dove inviare la copia Discord del log, oltre al canale di audit. */
export type AuditChannel = 'audit' | 'member' | 'blacklist';

export interface AuditService {
  /**
   * Registra un evento: sempre a database, e best-effort su Discord.
   * Non lancia mai per un errore di consegna del messaggio.
   */
  record(entry: AuditEntry, channels?: readonly AuditChannel[]): Promise<void>;
}

export function createAuditService(deps: {
  audit: AuditRepository;
  sink?: AuditSink | undefined;
}): AuditService {
  return {
    async record(entry, channels = ['audit']): Promise<void> {
      // 1. Database: fa parte dell'operazione, un errore qui deve propagarsi.
      await deps.audit.record(entry);

      // 2. Discord: puramente informativo, non puo' invalidare cio' che e'
      //    gia' stato persistito.
      const sink = deps.sink;
      if (!sink) return;

      for (const channel of channels) {
        try {
          switch (channel) {
            case 'audit':
              await sink.sendAudit(entry);
              break;
            case 'member':
              await sink.sendMemberLog(entry);
              break;
            case 'blacklist':
              await sink.sendBlacklistLog(entry);
              break;
            default: {
              const exhaustive: never = channel;
              throw new Error(`Canale di audit sconosciuto: ${String(exhaustive)}`);
            }
          }
        } catch (error) {
          log.error(
            { err: error, action: entry.action, channel },
            'Log di audit non consegnato su Discord (operazione comunque completata)',
          );
        }
      }
    },
  };
}

/** Helper per costruire il metadata in modo tipizzato. */
export function auditMetadata(values: JsonObject): JsonObject {
  return values;
}
