/**
 * Riconciliazione periodica dei membri.
 *
 * Sostituisce i tre eventi Gateway della V1 — `guildMemberAdd`,
 * `guildMemberRemove`, `guildMemberUpdate` — che senza connessione
 * persistente non esistono più. Al loro posto un Cron Trigger confronta
 * periodicamente lo stato Discord con l'ultimo snapshot salvato e ne deduce
 * gli stessi eventi.
 *
 * DUE MODALITÀ, UNA SOLA DEFINIZIONE DELLE REGOLE (`ROLE_SYNC_MODE`):
 *
 *  - `REPORT_ONLY` rileva e segnala con un `ROLE_SYNC_WARNING`, senza scrivere
 *    nulla sul database. È il comportamento storico del bot.
 *  - `IMPORT_SAFE` importa a database le transizioni COSTRUTTIVE e non ambigue.
 *
 * Le due modalità NON hanno due implementazioni: entrambe chiedono lo stesso
 * piano a `planRoleImport` e cambiano solo cosa ne fanno — una lo racconta,
 * l'altra lo applica. È l'unico modo perché un `REPORT_ONLY` che dice "ecco
 * cosa importerei" e l'`IMPORT_SAFE` che poi lo importa restino d'accordo.
 *
 * COSA NON VIENE MAI DEDOTTO, in nessuna modalità:
 *  - uscire dal Discord NON è lasciare la gang: nessun `LEFT_TTP` automatico;
 *  - togliere TTP a mano non imposta `LEFT`, e azzerare i rank non toglie la
 *    membership: servono `/member remove` e `/member rank`;
 *  - il ruolo `Banned` non crea una blacklist, e `Permadeath` non marca nessuno
 *    come morto: entrambe richiedono una motivazione e un autore, che un ruolo
 *    Discord non porta con sé;
 *  - la blacklist a database resta autorevole al rientro.
 *
 * ISOLAMENTO DEGLI ERRORI: ogni membro è indipendente. Se il trattamento di
 * un membro fallisce, il suo snapshot NON viene aggiornato — così la
 * prossima esecuzione riprova invece di dare per fatto qualcosa che non è
 * successo. È questo che rende il cron sicuro da ripetere. Uno stato solo
 * AMBIGUO invece non è un fallimento: si segnala e lo snapshot avanza, altrimenti
 * la stessa segnalazione tornerebbe a ogni esecuzione per sempre.
 */
import { AuditAction, MemberStatus } from '../generated/prisma/enums.js';
import { RANK_LABEL } from '../config/constants.js';
import type { RoleSyncMode } from '../config/env.js';
import type { RoleRegistry } from '../config/roles.js';
import type {
  GuildMemberSnapshotRepository,
  GuildMemberSnapshotRow,
  Repositories,
} from '../repositories/types.js';
import { createLogger } from '../utils/logger.js';
import type { AuditService } from './auditService.js';
import type { BlacklistService } from './blacklistService.js';
import type {
  DiscordRoleImportService,
  ImportedRoleChange,
  RoleImportOutcome,
} from './discordRoleImportService.js';
import { describeRoleImportAction } from './discordRoleState.js';
import type { MemberLifecycleMessageService } from './memberLifecycleMessageService.js';
import type { GuildMemberSnapshot } from './roleGateway.js';

const log = createLogger('reconciliation');

export interface ReconciliationReport {
  /** Modalità con cui il cron ha girato. */
  readonly mode: RoleSyncMode;
  /** Membri Discord osservati in questa esecuzione. */
  readonly scanned: number;
  readonly joined: number;
  readonly left: number;
  readonly roleChanges: number;
  /** Membri per cui almeno una modifica è stata scritta a database. */
  readonly imports: number;
  /** Divergenze rilevate e segnalate, mai corrette. */
  readonly warnings: number;
  /** Stati che un fatto autorevole a database vieta di importare. */
  readonly blocked: number;
  /** Rientri di utenti in blacklist. */
  readonly blacklistedRejoins: number;
  /** Membri il cui trattamento è fallito: riprovati alla prossima esecuzione. */
  readonly failures: number;

  // --- Dettaglio di cosa è stato importato --------------------------------
  readonly membersCreated: number;
  readonly membersReactivated: number;
  readonly ranksUpdated: number;
  readonly statusesUpdated: number;
  readonly specialRolesUpdated: number;
  readonly verificationsImported: number;

  /** Messaggi di benvenuto effettivamente pubblicati (best-effort). */
  readonly welcomeMessages: number;
  /** Messaggi di addio effettivamente pubblicati (best-effort). */
  readonly goodbyeMessages: number;
  /**
   * Prima esecuzione su una guild senza snapshot: lo stato viene fotografato
   * SENZA emettere eventi di join, che sarebbero centinaia di falsi positivi.
   * In `IMPORT_SAFE` i ruoli già presenti vengono comunque adottati.
   */
  readonly seeded: boolean;
  readonly durationMs: number;
}

/** Conteggi delle modifiche importate, accumulati durante un'esecuzione. */
interface ImportTally {
  members: number;
  membersCreated: number;
  membersReactivated: number;
  ranksUpdated: number;
  statusesUpdated: number;
  specialRolesUpdated: number;
  verificationsImported: number;
}

/**
 * Numero massimo di membri per cui un singolo Cron Trigger applica scritture
 * Discord -> database.
 *
 * Sul piano Cloudflare Workers Free un Cron Trigger dispone di 10 ms di CPU.
 * Il piano di un singolo membro puo' contenere piu' scritture (verifica,
 * membership e ruoli speciali), quindi il limite e' deliberatamente uno. Le
 * divergenze rimanenti vengono riprese dai cron successivi anche quando lo
 * snapshot Discord non e' cambiato.
 */
export const AUTO_IMPORT_MEMBER_BATCH_SIZE = 1;

function emptyTally(): ImportTally {
  return {
    members: 0,
    membersCreated: 0,
    membersReactivated: 0,
    ranksUpdated: 0,
    statusesUpdated: 0,
    specialRolesUpdated: 0,
    verificationsImported: 0,
  };
}

function tallyChanges(tally: ImportTally, changes: readonly ImportedRoleChange[]): void {
  if (changes.length > 0) tally.members += 1;
  for (const change of changes) {
    switch (change.kind) {
      case 'create-member':
        tally.membersCreated += 1;
        break;
      case 'reactivate-member':
        tally.membersReactivated += 1;
        break;
      case 'set-rank':
        tally.ranksUpdated += 1;
        break;
      case 'set-status':
        tally.statusesUpdated += 1;
        break;
      case 'add-special-role':
      case 'remove-special-role':
        tally.specialRolesUpdated += 1;
        break;
      case 'import-verification':
        tally.verificationsImported += 1;
        break;
      default: {
        const exhaustive: never = change.kind;
        throw new Error(`Modifica di import sconosciuta: ${String(exhaustive)}`);
      }
    }
  }
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
  /**
   * Registry dei ruoli: serve solo a ETICHETTARE i ruoli nei warning.
   *
   * Non c'è nessun `RoleService` fra le dipendenze, ed è deliberato: la
   * riconciliazione non assegna e non rimuove ruoli Discord, quindi non deve
   * nemmeno avere sottomano gli strumenti per farlo.
   */
  readonly roleRegistry: RoleRegistry;
  readonly audit: AuditService;
  readonly blacklist: BlacklistService;
  readonly listAllGuildMembers: () => Promise<GuildMemberSnapshot[]>;
  readonly guildId: string;
  /**
   * Che cosa fare di una modifica manuale dei ruoli. Default: `REPORT_ONLY`,
   * cioè il comportamento storico — un bot che non scrive da solo sul database
   * non deve poterlo diventare per dimenticanza.
   */
  readonly mode?: RoleSyncMode | undefined;
  /**
   * Calcolo e applicazione delle importazioni.
   *
   * NON opzionale, nemmeno in `REPORT_ONLY`: anche solo per descrivere una
   * divergenza servono le stesse regole che la importerebbero, e tenerne una
   * seconda copia qui dentro è esattamente il modo in cui report e import
   * finirebbero per non essere più d'accordo.
   */
  readonly roleImport: DiscordRoleImportService;
  /**
   * Messaggi pubblici di benvenuto/addio. Opzionale: senza, la
   * riconciliazione si comporta esattamente come prima di questa feature.
   */
  readonly lifecycle?: MemberLifecycleMessageService | undefined;
}

export function createMemberReconciliationService(
  deps: ReconciliationDeps,
): MemberReconciliationService {
  const { repos, roleRegistry, audit, blacklist, lifecycle, roleImport, guildId } = deps;
  const mode: RoleSyncMode = deps.mode ?? 'REPORT_ONLY';

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

  /** Etichetta leggibile di un ruolo Discord, per i messaggi di warning. */
  function roleLabel(roleId: string): string {
    return roleRegistry.all.find((descriptor) => descriptor.id === roleId)?.label ?? roleId;
  }

  /**
   * Registra una divergenza non importata.
   *
   * Dice sempre QUALI ruoli sono cambiati, non solo che qualcosa non torna:
   * senza quell'elenco un operatore deve ricostruire da sé cosa è successo
   * confrontando a occhio i ruoli del membro.
   */
  async function warnAboutDivergence(
    snapshot: GuildMemberSnapshot,
    reasons: readonly string[],
    added: readonly string[],
    removed: readonly string[],
    extra: Record<string, boolean | string>,
  ): Promise<void> {
    await audit.record(
      {
        action: AuditAction.ROLE_SYNC_WARNING,
        // Nessun attore: l'elenco dei membri della guild dice cosa è cambiato,
        // non chi l'ha cambiato.
        actorDiscordId: null,
        targetDiscordId: snapshot.discordId,
        reason: reasons.join('\n'),
        metadata: {
          added: added.map(roleLabel),
          removed: removed.map(roleLabel),
          // Il bot non ha toccato nulla: la correzione è una decisione umana.
          autoCorrected: false,
          source: 'reconciliation',
          mode,
          ...extra,
        },
      },
      ['audit'],
    );

    log.warn(
      { discordId: snapshot.discordId, reasons, mode },
      'Divergenza rilevata durante la riconciliazione',
    );
  }

  /** Esito del trattamento di un singolo membro con i ruoli cambiati. */
  interface RoleChangeOutcome {
    readonly warned: boolean;
    readonly blocked: boolean;
    readonly changes: readonly ImportedRoleChange[];
  }

  const NO_CHANGE: RoleChangeOutcome = { warned: false, blocked: false, changes: [] };

  /**
   * Sostituisce `guildMemberUpdate`.
   *
   * Confronta i ruoli gestiti con lo snapshot precedente e, a seconda della
   * modalità, importa o segnala. Le REGOLE sono le stesse in entrambi i casi:
   * `planRoleImport` è l'unico posto in cui vivono.
   */
  async function handleRoleChange(
    snapshot: GuildMemberSnapshot,
    previous: GuildMemberSnapshotRow,
  ): Promise<RoleChangeOutcome> {
    const before = new Set(previous.roleIds);
    const after = snapshot.roleIds;

    const added = [...after].filter((id) => !before.has(id));
    const removed = [...before].filter((id) => !after.has(id));

    // Solo i ruoli che il bot gestisce sono interessanti.
    const managedIds = new Set(roleRegistry.managed.map((descriptor) => descriptor.id));
    const relevantAdded = added.filter((id) => managedIds.has(id));
    const relevantRemoved = removed.filter((id) => managedIds.has(id));
    if (relevantAdded.length === 0 && relevantRemoved.length === 0) return NO_CHANGE;

    if (mode === 'IMPORT_SAFE') {
      const outcome = await roleImport.importMember({ snapshot });
      return handleImportOutcome(snapshot, outcome, relevantAdded, relevantRemoved);
    }

    // --- REPORT_ONLY -------------------------------------------------------
    // Stesso piano dell'import, raccontato invece che applicato. Le azioni che
    // `IMPORT_SAFE` eseguirebbe qui diventano righe di un warning, così le due
    // modalità non possono divergere nel giudizio su uno stesso stato.
    const plan = await roleImport.planFor(snapshot);

    switch (plan.kind) {
      case 'unchanged':
        return NO_CHANGE;

      case 'blocked':
        await warnAboutDivergence(
          snapshot,
          [plan.issue.detail, plan.issue.suggestion],
          relevantAdded,
          relevantRemoved,
          { importable: false },
        );
        return { warned: true, blocked: true, changes: [] };

      case 'warning':
        await warnAboutDivergence(
          snapshot,
          plan.issues.map((entry) => entry.detail),
          relevantAdded,
          relevantRemoved,
          { importable: false },
        );
        return { warned: true, blocked: false, changes: [] };

      case 'actions':
        await warnAboutDivergence(
          snapshot,
          [
            ...plan.actions.map(describeRoleImportAction),
            'Nessuna modifica applicata: ROLE_SYNC_MODE è REPORT_ONLY.',
          ],
          relevantAdded,
          relevantRemoved,
          { importable: true },
        );
        return { warned: true, blocked: false, changes: [] };

      default: {
        const exhaustive: never = plan;
        throw new Error(`Piano di import sconosciuto: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  /**
   * Traduce l'esito di un import in contatori e segnalazioni.
   *
   * Uno stato ambiguo produce un warning ma NON è un fallimento: lo snapshot
   * avanza comunque, altrimenti la stessa segnalazione tornerebbe a ogni cron
   * finché qualcuno non sistema i ruoli a mano. Resta visibile in
   * `/system sync-check`, che è il posto giusto per guardarla.
   */
  async function handleImportOutcome(
    snapshot: GuildMemberSnapshot,
    outcome: RoleImportOutcome,
    relevantAdded: readonly string[],
    relevantRemoved: readonly string[],
  ): Promise<RoleChangeOutcome> {
    switch (outcome.kind) {
      case 'unchanged':
        // Il database era già allineato: tipicamente un comando ha appena
        // fatto la stessa modifica e il cron sta solo osservando l'effetto.
        // Nessuno storico, nessun annuncio, nessun audit duplicato.
        return NO_CHANGE;

      case 'imported':
        log.info(
          {
            discordId: snapshot.discordId,
            changes: outcome.changes.map((change) => change.detail),
          },
          'Ruoli Discord importati a database',
        );
        return { warned: false, blocked: false, changes: outcome.changes };

      case 'warning':
        await warnAboutDivergence(snapshot, outcome.reasons, relevantAdded, relevantRemoved, {
          importable: false,
        });
        return { warned: true, blocked: false, changes: [] };

      case 'blocked':
        await warnAboutDivergence(snapshot, [outcome.reason], relevantAdded, relevantRemoved, {
          importable: false,
        });
        return { warned: true, blocked: true, changes: [] };

      default: {
        const exhaustive: never = outcome;
        throw new Error(`Esito di import sconosciuto: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  /**
   * Recupera una divergenza importabile che non compare piu' come modifica
   * dello snapshot (per esempio dopo un seed in REPORT_ONLY o dopo che un
   * batch precedente ha esaurito il budget).
   *
   * Gli stati manuali/ambigui restano visibili in `/system sync-check`, ma non
   * generano un nuovo audit a ogni cron. Solo un piano con azioni viene
   * applicato. `bootstrap: true` sopprime Put On / Put Off per questo backlog:
   * non conosciamo il momento reale in cui quei ruoli sono stati assegnati.
   */
  async function importActionableBacklog(
    snapshot: GuildMemberSnapshot,
  ): Promise<RoleChangeOutcome> {
    const plan = await roleImport.planFor(snapshot);
    if (plan.kind !== 'actions') return NO_CHANGE;

    const outcome = await roleImport.importMember({ snapshot, bootstrap: true });
    return handleImportOutcome(snapshot, outcome, [], []);
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

  /**
   * Prima esecuzione su una guild senza snapshot.
   *
   * Due preoccupazioni opposte da tenere insieme:
   *
   *  - NON emettere eventi. Chi c'era già non è "appena arrivato": niente
   *    MEMBER_JOINED_DISCORD, niente messaggi di benvenuto, niente Put On/Put
   *    Off. Al primo cron sarebbero centinaia di notifiche false e un ping a
   *    tutto il server.
   *  - In `IMPORT_SAFE`, ADOTTARE comunque lo stato. I ruoli assegnati prima
   *    del deploy non produrranno mai un cambiamento osservabile, quindi o
   *    entrano nel database adesso o non ci entreranno mai.
   *
   * Funziona anche su una guild mista, dove alcuni record esistono già e altri
   * no: ogni membro viene valutato per conto proprio, e chi è già allineato
   * risulta semplicemente `unchanged`.
   */
  async function seedGuild(
    current: readonly GuildMemberSnapshot[],
    now: Date,
    startedAt: number,
  ): Promise<ReconciliationReport> {
    const tally = emptyTally();
    let warnings = 0;
    let blocked = 0;
    let failures = 0;
    let importsRemaining = AUTO_IMPORT_MEMBER_BATCH_SIZE;

    const toPersist: Parameters<GuildMemberSnapshotRepository['upsertMany']>[0][number][] = [];

    for (const snapshot of current) {
      if (mode === 'IMPORT_SAFE' && importsRemaining > 0) {
        try {
          const result = await importActionableBacklog(snapshot);
          if (result.warned) warnings += 1;
          if (result.blocked) blocked += 1;
          tallyChanges(tally, result.changes);
          if (result.changes.length > 0) importsRemaining -= 1;
        } catch (error) {
          // Stessa regola del regime normale: snapshot non scritto, quindi il
          // prossimo cron tratterà questo membro come una modifica da valutare.
          failures += 1;
          log.error(
            { err: error, discordId: snapshot.discordId },
            'Adozione iniziale del membro fallita: sarà riprovata',
          );
          continue;
        }
      }

      toPersist.push({
        guildId,
        discordId: snapshot.discordId,
        inGuild: true,
        roleIds: [...snapshot.roleIds],
        rolesHash: hashRoleIds(snapshot.roleIds),
        nickname: snapshot.displayName,
        seenAt: now,
      });
    }

    if (toPersist.length > 0) await repos.snapshots.upsertMany(toPersist);

    const report: ReconciliationReport = {
      mode,
      scanned: current.length,
      joined: 0,
      left: 0,
      roleChanges: 0,
      imports: tally.members,
      warnings,
      blocked,
      blacklistedRejoins: 0,
      failures,
      membersCreated: tally.membersCreated,
      membersReactivated: tally.membersReactivated,
      ranksUpdated: tally.ranksUpdated,
      statusesUpdated: tally.statusesUpdated,
      specialRolesUpdated: tally.specialRolesUpdated,
      verificationsImported: tally.verificationsImported,
      // NESSUN benvenuto qui: il seed non è un'ondata di arrivi, è la
      // fotografia di chi c'era già.
      welcomeMessages: 0,
      goodbyeMessages: 0,
      seeded: true,
      durationMs: Date.now() - startedAt,
    };

    // Una sola riga aggregata, non una per membro: è il report che dice
    // "l'adozione è avvenuta, ed è andata così". Le singole modifiche restano
    // tracciate dalle rispettive azioni di dominio, riconoscibili dal
    // `metadata.source = 'discord_bootstrap'`.
    if (mode === 'IMPORT_SAFE') {
      await audit.record(
        {
          action: AuditAction.ROLE_SYNC_BOOTSTRAP,
          actorDiscordId: null,
          reason: 'Adozione iniziale dei ruoli Discord già assegnati prima del deploy',
          metadata: {
            source: 'discord_bootstrap',
            progressive: true,
            maxMembersPerRun: AUTO_IMPORT_MEMBER_BATCH_SIZE,
            scanned: report.scanned,
            imports: report.imports,
            membersCreated: report.membersCreated,
            membersReactivated: report.membersReactivated,
            ranksUpdated: report.ranksUpdated,
            statusesUpdated: report.statusesUpdated,
            specialRolesUpdated: report.specialRolesUpdated,
            verificationsImported: report.verificationsImported,
            warnings: report.warnings,
            blocked: report.blocked,
            failures: report.failures,
          },
        },
        ['audit'],
      );
    }

    log.info({ ...report }, 'Snapshot iniziale della guild registrato');
    return report;
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

      // --- Prima esecuzione ------------------------------------------------
      // Senza un trattamento a parte, il primo cron su una guild già popolata
      // emetterebbe un MEMBER_JOINED_DISCORD per ogni membro esistente.
      //
      // In `IMPORT_SAFE` però non basta fotografare: i ruoli assegnati PRIMA
      // del deploy non produrranno mai una modifica osservabile — sono già lì —
      // e senza questo passaggio resterebbero fuori dal database per sempre.
      // Quindi si adottano ora, in silenzio.
      if (previousRows.length === 0) {
        return await seedGuild(current, now, startedAt);
      }

      let joined = 0;
      let left = 0;
      let roleChanges = 0;
      let warnings = 0;
      let blocked = 0;
      let blacklistedRejoins = 0;
      let failures = 0;
      const tally = emptyTally();
      let importsRemaining = AUTO_IMPORT_MEMBER_BATCH_SIZE;

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
        let shouldPersistSnapshot = true;

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

              // Un join va valutato come ogni altro stato, anche se è il primo.
              //
              // Chi RIENTRA si porta dietro i ruoli di prima, che Discord
              // conserva. Ma anche un arrivo nuovo può avere già dei ruoli, se
              // qualcuno glieli assegna nei minuti fra l'ingresso e questo
              // cron: lo snapshot li fotograferebbe come stato di partenza e
              // da quel momento non risulterebbero più "cambiati", quindi non
              // verrebbero importati mai più. Per chi non ha nessun ruolo
              // gestito il piano è vuoto e questa chiamata non fa nulla.
              if (mode === 'IMPORT_SAFE' && importsRemaining > 0) {
                const imported = await roleImport.importMember({ snapshot });
                const result = await handleImportOutcome(snapshot, imported, [], []);
                if (result.warned) warnings += 1;
                if (result.blocked) blocked += 1;
                tallyChanges(tally, result.changes);
                if (result.changes.length > 0) importsRemaining -= 1;
              }
            }
          } else if (previous.rolesHash !== rolesHash) {
            roleChanges += 1;
            if (mode === 'IMPORT_SAFE' && importsRemaining === 0) {
              // Non fotografare come completata una modifica che questo batch
              // non ha potuto valutare: il prossimo cron deve rivederla come
              // vero role change (e mantenere l'eventuale annuncio).
              shouldPersistSnapshot = false;
            } else {
              const outcome = await handleRoleChange(snapshot, previous);
              if (outcome.warned) warnings += 1;
              if (outcome.blocked) blocked += 1;
              tallyChanges(tally, outcome.changes);
              if (outcome.changes.length > 0) importsRemaining -= 1;
            }
          } else if (mode === 'IMPORT_SAFE' && importsRemaining > 0) {
            // Lo snapshot puo' essere allineato mentre il database non lo e':
            // succede dopo REPORT_ONLY e nei bootstrap interrotti. Il piano
            // condiviso con sync-check rende il recupero convergente.
            const outcome = await importActionableBacklog(snapshot);
            if (outcome.warned) warnings += 1;
            if (outcome.blocked) blocked += 1;
            tallyChanges(tally, outcome.changes);
            if (outcome.changes.length > 0) importsRemaining -= 1;
          }

          if (shouldPersistSnapshot) {
            toPersist.push({
              guildId,
              discordId: snapshot.discordId,
              inGuild: true,
              roleIds: [...snapshot.roleIds],
              rolesHash,
              nickname: snapshot.displayName,
              seenAt: now,
            });
          }
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
        mode,
        scanned: current.length,
        joined,
        left,
        roleChanges,
        imports: tally.members,
        warnings,
        blocked,
        blacklistedRejoins,
        failures,
        membersCreated: tally.membersCreated,
        membersReactivated: tally.membersReactivated,
        ranksUpdated: tally.ranksUpdated,
        statusesUpdated: tally.statusesUpdated,
        specialRolesUpdated: tally.specialRolesUpdated,
        verificationsImported: tally.verificationsImported,
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
