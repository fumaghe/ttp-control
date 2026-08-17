/**
 * Registry dei canali Discord usati dal bot.
 *
 * Nota storica: `verifyRequests` conserva il nome env legacy
 * CHANNEL_VERIFY_REQUESTS_ID, ma concettualmente ospita le CANDIDATURE TTP,
 * non le verifiche (che non richiedono approvazione).
 */
import { type Env } from './env.js';

export interface ChannelDescriptor {
  readonly key: string;
  readonly id: string;
  readonly label: string;
  /** Il bot deve poterci scrivere. */
  readonly requiresSend: boolean;
}

export interface ChannelRegistry {
  /** Pannello pubblico di verifica. */
  readonly verify: string;
  /** Candidature TTP da revisionare dalla Leadership. */
  readonly ttpRequests: string;
  readonly memberManagement: string;
  readonly memberLogs: string;
  readonly auditLog: string;
  readonly blacklist: string;
  readonly controlPanel: string;
  readonly all: readonly ChannelDescriptor[];
}

export function buildChannelRegistry(env: Env): ChannelRegistry {
  const c = env.channels;

  const all: ChannelDescriptor[] = [
    { key: 'verify', id: c.verify, label: 'Verify Channel', requiresSend: true },
    {
      key: 'ttpRequests',
      id: c.verifyRequests,
      label: 'TTP Requests Channel',
      requiresSend: true,
    },
    {
      key: 'memberManagement',
      id: c.memberManagement,
      label: 'Member Management',
      requiresSend: true,
    },
    { key: 'memberLogs', id: c.memberLogs, label: 'Member Logs', requiresSend: true },
    { key: 'auditLog', id: c.auditLog, label: 'Audit Log', requiresSend: true },
    { key: 'blacklist', id: c.blacklist, label: 'Blacklist', requiresSend: true },
    { key: 'controlPanel', id: c.controlPanel, label: 'Control Panel', requiresSend: true },
  ];

  return {
    verify: c.verify,
    ttpRequests: c.verifyRequests,
    memberManagement: c.memberManagement,
    memberLogs: c.memberLogs,
    auditLog: c.auditLog,
    blacklist: c.blacklist,
    controlPanel: c.controlPanel,
    all,
  };
}
