/**
 * Riconciliazione periodica dei membri.
 *
 * Sostituisce i tre eventi Gateway della V1 — `guildMemberAdd`,
 * `guildMemberRemove`, `guildMemberUpdate` — che senza connessione
 * persistente non esistono più. Al loro posto un Cron Trigger confronta
 * periodicamente lo stato Discord con l'ultimo snapshot salvato e ne deduce
 * gli stessi eventi.
 *
 * PRINCIPIO INVARIATO: il bot OSSERVA e SEGNALA, non corregge da solo.
 *  - uscire dal Discord NON è lasciare la gang: nessun `LEFT_TTP` automatico,
 *    nessun `/member remove` implicito;
 *  - una modifica manuale dei ruoli produce un `ROLE_SYNC_WARNING`, mai una
 *    sincronizzazione distruttiva;
 *  - la blacklist a database resta autorevole al rientro.
 *
 * ISOLAMENTO DEGLI ERRORI: ogni membro è indipendente. Se il trattamento di
 * un membro fallisce, il suo snapshot NON viene aggiornato — così la
 * prossima esecuzione riprova invece di dare per fatto qualcosa che non è
 * successo. È questo che rende il cron sicuro da ripetere.
 */
import { AuditAction, MemberStatus } from '../generated/prisma/enums.js';
import { RANK_LABEL } from '../config/constants.js';
import type { RoleRegistry } from '../config/roles.js';
import type {
  GuildMemberSnapshotRepository,
  GuildMemberSnapshotRow,
  Repositories,
} from '../repositories/types.js';
import { createLogger } from '../utils/logger.js';
import type { AuditService } from './auditService.js';
import type { BlacklistService } from './blacklistService.js';
import type { MemberLifecycleMessageService } from './memberLifecycleMessageService.js';
import type { GuildMemberSnapshot } from './roleGateway.js';
import type { RoleService } from './roleService.js';

const log = createLogger('reconciliation');

export interface ReconciliationReport {
  /** Membri Discord osservati in questa esecuzione. */
  readonly scanned: number;
  readonly joined: number;
  readonly left: number;
  readonly roleChanges: number;
  /** Divergenze rilevate e segnalate, mai corrette. */
  readonly warnings: number;
  /** Rientri di utenti in blacklist. */
  readonly blacklistedRejoins: number;
  /** Membri il cui trattamento è fallito: riprovati alla prossima esecuzione. */
  readonly failures: number;
  /** Messaggi di benvenuto effettivamente pubblicati (best-effort). */
  readonly welcomeMessages: number;
  /** Messaggi di addio effettivamente pubblicati (best-effort). */
  readonly goodbyeMessages: number;
  /**
   * Prima esecuzione su una guild senza snapshot: lo stato viene fotografato
   * SENZA emettere eventi di join, che sarebbero centinaia di falsi positivi.
   */
  readonly seeded: boolean;
  readonly durationMs: number;
}

export interface MemberReconciliationService {
  run(): Promise<ReconciliationReport>;
}

/**
 * Impronta stabile dell'insieme di ruoli.
 *
 * Ordinata, così l'ordine in cui Discord restituisce i ruoli non produce
 * differenze inesistenti. Non è una funzione crittografica: serve solo a
 * confrontare due insiemi senza rileggerli per intero.
 */
export function hashRoleIds(roleIds: Iterable<string>): string {
  const sorted = [...roleIds].sort();
  let hash = 0x811c9dc5;
  for (const id of sorted) {
    for (let index = 0; index < id.length; index += 1) {
      hash ^= id.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    hash ^= 0x2c; // separatore fra ID: "1","23" e "12","3" non collidono
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${sorted.length}:${hash.toString(16)}`;
}

export interface ReconciliationDeps {
  readonly repos: Repositories & { readonly snapshots: GuildMemberSnapshotRepository };
  readonly roles: RoleService;
  readonly roleRegistry: RoleRegistry;
  readonly audit: AuditService;
  readonly blacklist: BlacklistService;
  readonly listAllGuildMembers: () => Promise<GuildMemberSnapshot[]>;
  readonly guildId: string;
  /**
   * Messaggi pubblici di benvenuto/addio. Opzionale: senza, la
   * riconciliazione si comporta esattamente come prima di questa feature.
   */
  readonly lifecycle?: MemberLifecycleMessageService | undefined;
}

export function createMemberReconciliationService(
  deps: ReconciliationDeps,
): MemberReconciliationService {
  const { repos, roles, roleRegistry, audit, blacklist, lifecycle, guildId } = deps;

  /**
   * Sostituisce `guildMemberAdd`.
   *
   * Nessun ruolo viene assegnato: la verifica resta un atto volontario
   * dell'utente. La blacklist è autorevole a database, quindi uscire e
   * rientrare non la aggira.
   */
  async function handleJoin(
    snapshot: GuildMemberSnapshot,
    rejoin: boolean,
  ): Promise<{ blacklisted: boolean }> {
    await repos.profiles.upsert({
      discordId: snapshot.discordId,
      username: snapshot.username,
      displayName: snapshot.displayName,
    });

    await audit.record({
      action: AuditAction.MEMBER_JOINED_DISCORD,
      targetDiscordId: snapshot.discordId,
      metadata: { username: snapshot.username, rejoin, source: 'reconciliation' },
    });

    const entry = await blacklist.handleRejoin(snapshot.discordId, snapshot.username);
    if (entry) {
      log.warn({ discordId: snapshot.discordId }, 'Utente in blacklist rientrato nel server');
      return { blacklisted: true };
    }
    return { blacklisted: false };
  }

  /**
   * Sostituisce `guildMemberRemove`.
   *
   * Uscire dal Discord NON è `LEFT_TTP`: si avvisa la Leadership e si lascia
   * a loro la decisione, senza toccare lo storico di membership.
   */
  async function handleLeave(previous: GuildMemberSnapshotRow): Promise<{ warned: boolean }> {
    const dbMember = await repos.members.findByDiscordId(previous.discordId);
    const wasInGang =
      dbMember !== null &&
      (dbMember.status === MemberStatus.ACTIVE || dbMember.status === MemberStatus.INACTIVE);

    await audit.record(
      {
        action: AuditAction.MEMBER_LEFT_DISCORD,
        targetDiscordId: previous.discordId,
        metadata: {
          wasTtpMember: wasInGang,
          rank: dbMember?.rank ?? null,
          // Esplicito: nessuna modifica automatica alla membership.
          membershipUnchanged: true,
          source: 'reconciliation',
        },
        reason: wasInGang
          ? 'Un membro TTP ha lasciato il Discord: la membership NON è stata modificata automaticamente'
          : null,
      },
      wasInGang ? ['audit', 'member'] : ['audit'],
    );

    if (wasInGang) {
      // Segnalazione esplicita: serve una decisione umana.
      await audit.record(
        {
          action: AuditAction.ROLE_SYNC_WARNING,
          targetDiscordId: previous.discordId,
          entityType: 'Member',
          entityId: dbMember.id,
          reason: `Il membro ${RANK_LABEL[dbMember.rank]} ha lasciato il Discord. Usa \`/member remove\` se ha davvero lasciato la gang.`,
        },
        ['member'],
      );
      return { warned: true };
    }
    return { warned: false };
  }

  /**
   * Sostituisce `guildMemberUpdate`.
   *
   * Confronta i ruoli gestiti con lo snapshot precedente e applica gli stessi
   * consistency check della V1. NESSUNA correzione automatica.
   */
  async function handleRoleChange(
    snapshot: GuildMemberSnapshot,
    previous: GuildMemberSnapshotRow,
  ): Promise<{ warned: boolean }> {
    const before = new Set(previous.roleIds);
    const after = snapshot.roleIds;

    const added = [...after].filter((id) => !before.has(id));
    const removed = [...before].filter((id) => !after.has(id));

    // Solo i ruoli che il bot gestisce sono interessanti.
    const managedIds = new Set(roleRegistry.managed.map((descriptor) => descriptor.id));
    const relevantAdded = added.filter((id) => managedIds.has(id));
    const relevantRemoved = removed.filter((id) => managedIds.has(id));
    if (relevantAdded.length === 0 && relevantRemoved.length === 0) return { warned: false };

    const dbMember = await repos.members.findByDiscordId(snapshot.discordId);
    const verification = await repos.verifications.findActive(snapshot.discordId);

    const divergences: string[] = [];

    const isTtp = roles.isTtp(snapshot);
    const inGang =
      dbMember !== null &&
      (dbMember.status === MemberStatus.ACTIVE || dbMember.status === MemberStatus.INACTIVE);

    if (isTtp !== inGang) {
      divergences.push(
        isTtp
          ? 'Ha il ruolo TTP ma a database non risulta membro attivo.'
          : 'Risulta membro a database ma non ha più il ruolo TTP.',
      );
    }

    const ranks = roles.readAllRanks(snapshot);
    if (ranks.length > 1) {
      divergences.push(`Ha ${ranks.length} rank contemporaneamente.`);
    }
    const soleRank = ranks.length === 1 ? ranks[0] : undefined;
    if (dbMember && inGang && soleRank !== undefined && soleRank !== dbMember.rank) {
      divergences.push(
        `Rank Discord (${RANK_LABEL[soleRank]}) diverso dal database (${RANK_LABEL[dbMember.rank]}).`,
      );
    }

    const isVerified = roles.isVerified(snapshot);
    if (isTtp && !isVerified) {
      divergences.push('Ha il ruolo TTP ma non Verified: viola `TTP ⇒ Verified`.');
    }
    if (isVerified !== (verification !== null)) {
      divergences.push(
        isVerified
          ? 'Ha il ruolo Verified ma nessuna verifica attiva a database.'
          : 'Ha una verifica attiva a database ma non il ruolo Verified.',
      );
    }

    // `Inactive` è additivo e non deve divergere dallo stato a database.
    if (dbMember && inGang) {
      const hasInactiveRole = after.has(roleRegistry.inactive);
      const shouldBeInactive = dbMember.status === MemberStatus.INACTIVE;
      if (hasInactiveRole !== shouldBeInactive) {
        divergences.push(
          shouldBeInactive
            ? 'È INACTIVE a database ma il ruolo Inactive è stato rimosso a mano.'
            : 'Ha il ruolo Inactive su Discord ma a database è ACTIVE.',
        );
      }
    }

    if (divergences.length === 0) return { warned: false };

    const nameOf = (id: string): string =>
      roleRegistry.all.find((descriptor) => descriptor.id === id)?.label ?? id;

    await audit.record(
      {
        action: AuditAction.ROLE_SYNC_WARNING,
        targetDiscordId: snapshot.discordId,
        reason: divergences.join('\n'),
        metadata: {
          added: relevantAdded.map(nameOf),
          removed: relevantRemoved.map(nameOf),
          // Il bot non tocca nulla: la correzione è una decisione umana.
          autoCorrected: false,
          source: 'reconciliation',
        },
      },
      ['audit'],
    );

    log.warn(
      { discordId: snapshot.discordId, divergences },
      'Divergenza rilevata durante la riconciliazione',
    );
    return { warned: true };
  }

  /**
   * Messaggi pubblici di benvenuto e addio.
   *
   * BEST-EFFORT, e in fondo alla riconciliazione di proposito: viene chiamata
   * solo dopo che audit e snapshot sono stati scritti, quindi un messaggio
   * non recapitato non può far ritrattare l'evento alla prossima esecuzione.
   * Non lancia mai — il lifecycle service è già a prova di errore, e il
   * `catch` qui copre anche un'implementazione che non lo fosse.
   */
  async function dispatchLifecycleMessages(
    welcomes: readonly GuildMemberSnapshot[],
    goodbyes: readonly GuildMemberSnapshotRow[],
  ): Promise<{ welcome: number; goodbye: number }> {
    if (!lifecycle) return { welcome: 0, goodbye: 0 };

    let welcome = 0;
    let goodbye = 0;

    for (const snapshot of welcomes) {
      try {
        const sent = await lifecycle.sendWelcome({
          discordId: snapshot.discordId,
          bot: snapshot.bot,
          avatar: snapshot.avatar,
        });
        if (sent) welcome += 1;
      } catch (error) {
        log.error({ err: error, discordId: snapshot.discordId }, 'Benvenuto non inviato');
      }
    }

    for (const previous of goodbyes) {
      try {
        const sent = await lifecycle.sendGoodbye({
          discordId: previous.discordId,
          // Il nome dell'ultima osservazione: dopo l'uscita non è più leggibile.
          displayName: previous.nickname ?? previous.discordId,
        });
        if (sent) goodbye += 1;
      } catch (error) {
        log.error({ err: error, discordId: previous.discordId }, 'Messaggio di addio non inviato');
      }
    }

    return { welcome, goodbye };
  }

  return {
    async run(): Promise<ReconciliationReport> {
      const startedAt = Date.now();

      const [current, previousRows] = await Promise.all([
        deps.listAllGuildMembers(),
        repos.snapshots.listForGuild(guildId),
      ]);

      const previousById = new Map(previousRows.map((row) => [row.discordId, row]));
      const now = new Date();

      // --- Prima esecuzione: si fotografa e basta -------------------------
      // Senza questo, il primo cron su una guild già popolata emetterebbe un
      // MEMBER_JOINED_DISCORD per ogni membro esistente.
      if (previousRows.length === 0) {
        await repos.snapshots.upsertMany(
          current.map((snapshot) => ({
            guildId,
            discordId: snapshot.discordId,
            inGuild: true,
            roleIds: [...snapshot.roleIds],
            rolesHash: hashRoleIds(snapshot.roleIds),
            nickname: snapshot.displayName,
            seenAt: now,
          })),
        );

        // NESSUN benvenuto qui: il seed non è un'ondata di arrivi, è la
        // fotografia di chi c'era già. Mandarli significherebbe taggare
        // l'intero server al primo cron.
        log.info({ members: current.length }, 'Snapshot iniziale della guild registrato');
        return {
          scanned: current.length,
          joined: 0,
          left: 0,
          roleChanges: 0,
          warnings: 0,
          blacklistedRejoins: 0,
          failures: 0,
          welcomeMessages: 0,
          goodbyeMessages: 0,
          seeded: true,
          durationMs: Date.now() - startedAt,
        };
      }

      let joined = 0;
      let left = 0;
      let roleChanges = 0;
      let warnings = 0;
      let blacklistedRejoins = 0;
      let failures = 0;

      const toPersist: Parameters<GuildMemberSnapshotRepository['upsertMany']>[0][number][] = [];

      // I messaggi pubblici si accumulano qui e partono SOLO a stato scritto:
      // così un canale mal configurato non può far ritrattare lo stesso join
      // a ogni esecuzione del cron. Vedi `dispatchLifecycleMessages`.
      const pendingWelcomes: GuildMemberSnapshot[] = [];
      const pendingGoodbyes: GuildMemberSnapshotRow[] = [];

      // --- Lato Discord: presenti adesso ----------------------------------
      for (const snapshot of current) {
        const previous = previousById.get(snapshot.discordId);
        const rolesHash = hashRoleIds(snapshot.roleIds);

        try {
          if (!previous?.inGuild) {
            joined += 1;
            const outcome = await handleJoin(snapshot, previous !== undefined);
            if (outcome.blacklisted) {
              blacklistedRejoins += 1;
              // La blacklist ha la precedenza: chi è bandito rientra in
              // silenzio, non con un benvenuto pubblico.
            } else {
              pendingWelcomes.push(snapshot);
            }
          } else if (previous.rolesHash !== rolesHash) {
            roleChanges += 1;
            const outcome = await handleRoleChange(snapshot, previous);
            if (outcome.warned) warnings += 1;
          }

          toPersist.push({
            guildId,
            discordId: snapshot.discordId,
            inGuild: true,
            roleIds: [...snapshot.roleIds],
            rolesHash,
            nickname: snapshot.displayName,
            seenAt: now,
          });
        } catch (error) {
          // Snapshot NON aggiornato: la prossima esecuzione riprova. È il
          // motivo per cui una failure del cron non corrompe lo stato.
          failures += 1;
          log.error(
            { err: error, discordId: snapshot.discordId },
            'Riconciliazione del membro fallita: sarà riprovata',
          );
        }
      }

      // --- Lato database: chi c'era e non c'è più --------------------------
      const currentIds = new Set(current.map((snapshot) => snapshot.discordId));
      for (const previous of previousRows) {
        if (!previous.inGuild || currentIds.has(previous.discordId)) continue;

        try {
          left += 1;
          const outcome = await handleLeave(previous);
          if (outcome.warned) warnings += 1;
          await repos.snapshots.markLeft(guildId, previous.discordId, now);
          pendingGoodbyes.push(previous);
        } catch (error) {
          failures += 1;
          log.error(
            { err: error, discordId: previous.discordId },
            'Registrazione dell’uscita fallita: sarà riprovata',
          );
        }
      }

      if (toPersist.length > 0) await repos.snapshots.upsertMany(toPersist);

      // Ultimo passo, a stato già scritto: da qui in poi nessun errore può
      // più annullare una riconciliazione già avvenuta.
      const messages = await dispatchLifecycleMessages(pendingWelcomes, pendingGoodbyes);

      const report: ReconciliationReport = {
        scanned: current.length,
        joined,
        left,
        roleChanges,
        warnings,
        blacklistedRejoins,
        failures,
        welcomeMessages: messages.welcome,
        goodbyeMessages: messages.goodbye,
        seeded: false,
        durationMs: Date.now() - startedAt,
      };

      log.info({ ...report }, 'Riconciliazione completata');
      return report;
    },
  };
}
