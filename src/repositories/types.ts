/**
 * Contratti del repository layer.
 *
 * I service dipendono da queste interfacce, non da Prisma. Due conseguenze:
 *  - la business logic e' testabile con implementazioni in memoria, senza
 *    database ne' Discord;
 *  - nessun handler puo' scrivere query: l'unico strato che tocca Prisma e'
 *    `src/repositories/*.prisma.ts`.
 */
import type {
  AuditAction,
  MemberHistoryEvent,
  MemberRank,
  MemberStatus,
  PanelType,
  SpecialRole,
  TtpApplicationStatus,
} from '../generated/prisma/enums.js';
// Prisma 7 espone il tipo della riga come `<Modello>Model`; qui lo
// rinominiamo al nome di dominio, che e' quello usato in tutto il progetto.
import type {
  AuditLogModel,
  BlacklistEntryModel,
  DiscordProfileModel,
  GuildConfigModel,
  MemberHistoryModel,
  MemberModel,
  MemberSpecialRoleModel,
  PersistentPanelModel,
  TtpApplicationModel,
  VerificationModel,
} from '../generated/prisma/models.js';

export type AuditLog = AuditLogModel;
export type BlacklistEntry = BlacklistEntryModel;
export type DiscordProfile = DiscordProfileModel;
export type GuildConfig = GuildConfigModel;
export type Member = MemberModel;
export type MemberHistory = MemberHistoryModel;
export type MemberSpecialRole = MemberSpecialRoleModel;
export type PersistentPanel = PersistentPanelModel;
export type TtpApplication = TtpApplicationModel;
export type Verification = VerificationModel;

// -----------------------------------------------------------------------------
// DiscordProfile
// -----------------------------------------------------------------------------

export interface ProfileIdentity {
  readonly discordId: string;
  readonly username: string;
  readonly displayName?: string | null;
}

export interface DiscordProfileRepository {
  /** Crea o aggiorna l'anagrafica e rinfresca `lastSeenAt`. */
  upsert(identity: ProfileIdentity): Promise<DiscordProfile>;
  findByDiscordId(discordId: string): Promise<DiscordProfile | null>;
  /** Imposta (o azzera con `null`) la data di verifica denormalizzata. */
  setVerifiedAt(discordId: string, verifiedAt: Date | null): Promise<void>;
  countVerified(): Promise<number>;
  /** Profili con verifica attiva, per `/community list`. */
  listVerified(options?: { skip?: number; take?: number }): Promise<DiscordProfile[]>;
}

// -----------------------------------------------------------------------------
// Verification
// -----------------------------------------------------------------------------

export interface VerificationInput {
  readonly discordId: string;
  readonly rpName: string;
  readonly rpSurname: string;
  readonly citizenId: string;
  readonly phone: string;
  readonly referral: string;
}

export interface VerificationRepository {
  /**
   * Registra una verifica. Se ne esiste gia' una revocata per lo stesso
   * utente, la riattiva con i dati nuovi.
   */
  create(input: VerificationInput): Promise<Verification>;
  findByDiscordId(discordId: string): Promise<Verification | null>;
  /** Verifica non revocata, oppure `null`. */
  findActive(discordId: string): Promise<Verification | null>;
  revoke(discordId: string, revokedByDiscordId: string, reason?: string): Promise<void>;
  countActive(): Promise<number>;
}

// -----------------------------------------------------------------------------
// TtpApplication
// -----------------------------------------------------------------------------

export interface TtpApplicationRepository {
  /**
   * Crea una candidatura PENDING.
   * @throws se esiste gia' una PENDING per lo stesso utente (unique DB).
   */
  createPending(input: { discordId: string; notes?: string | undefined }): Promise<TtpApplication>;
  findById(id: string): Promise<TtpApplication | null>;
  findPendingByDiscordId(discordId: string): Promise<TtpApplication | null>;
  listByDiscordId(discordId: string): Promise<TtpApplication[]>;
  listPending(options?: { skip?: number; take?: number }): Promise<TtpApplication[]>;
  countPending(): Promise<number>;
  /** Collega il messaggio di review, per poterlo aggiornare dopo. */
  attachMessage(id: string, channelId: string, messageId: string): Promise<void>;
  /**
   * Passa da PENDING a uno stato finale.
   * @returns la candidatura aggiornata, oppure `null` se non era piu' PENDING
   *          (secondo click, doppio approve, race fra due operatori).
   */
  resolve(
    id: string,
    input: {
      status: Exclude<TtpApplicationStatus, 'PENDING'>;
      reviewedByDiscordId: string;
      rejectionReason?: string | undefined;
      initialRank?: MemberRank | undefined;
    },
  ): Promise<TtpApplication | null>;

  /**
   * Compensazione: riporta a PENDING una candidatura appena approvata il cui
   * ingresso e' poi fallito. Senza questo resterebbe un APPROVED senza
   * `Member`, che e' l'incoerenza peggiore fra quelle possibili.
   *
   * @returns `null` se non era piu' riportabile indietro (stato diverso, o
   *          nel frattempo e' comparsa un'altra candidatura PENDING).
   */
  revertToPending(id: string): Promise<TtpApplication | null>;
}

// -----------------------------------------------------------------------------
// Member
// -----------------------------------------------------------------------------

export interface MemberCreateInput {
  readonly discordId: string;
  readonly rank: MemberRank;
  readonly rpName?: string | null;
  readonly rpSurname?: string | null;
  readonly citizenId?: string | null;
  readonly phone?: string | null;
  readonly recruitedByDiscordId?: string | null;
  readonly notes?: string | null;
}

export interface MemberFilter {
  readonly rank?: MemberRank | undefined;
  readonly status?: MemberStatus | undefined;
  readonly statusIn?: readonly MemberStatus[] | undefined;
}

export interface MemberCounts {
  readonly total: number;
  readonly active: number;
  readonly inactive: number;
  readonly permadeath: number;
  readonly left: number;
  readonly byRank: Readonly<Record<MemberRank, number>>;
}

export interface MemberRepository {
  findByDiscordId(discordId: string): Promise<Member | null>;
  findById(id: string): Promise<Member | null>;
  create(input: MemberCreateInput): Promise<Member>;
  list(filter?: MemberFilter): Promise<Member[]>;
  counts(): Promise<MemberCounts>;
  countByStatus(status: MemberStatus): Promise<number>;

  /**
   * Aggiorna rank e/o status verificando `expectedVersion` (locking
   * ottimistico) e incrementando `version`.
   *
   * @returns il membro aggiornato, oppure `null` se la versione non
   *          corrisponde piu': qualcun altro ha modificato lo stesso membro
   *          nel frattempo e l'operazione va rifiutata, non riapplicata.
   */
  updateWithVersion(
    id: string,
    expectedVersion: number,
    patch: {
      rank?: MemberRank | undefined;
      status?: MemberStatus | undefined;
      leftTtpAt?: Date | null | undefined;
      joinedTtpAt?: Date | undefined;
      notes?: string | null | undefined;
      recruitedByDiscordId?: string | null | undefined;
      rpName?: string | null | undefined;
      rpSurname?: string | null | undefined;
      citizenId?: string | null | undefined;
      phone?: string | null | undefined;
    },
  ): Promise<Member | null>;

  /** Aggiorna solo le note, senza toccare il locking di rank/status. */
  setNotes(id: string, notes: string | null): Promise<Member>;
}

// -----------------------------------------------------------------------------
// MemberHistory
// -----------------------------------------------------------------------------

export interface MemberHistoryInput {
  readonly memberId: string;
  readonly discordId: string;
  readonly event: MemberHistoryEvent;
  readonly fromRank?: MemberRank | null;
  readonly toRank?: MemberRank | null;
  readonly fromStatus?: MemberStatus | null;
  readonly toStatus?: MemberStatus | null;
  readonly specialRole?: SpecialRole | null;
  readonly actorDiscordId?: string | null;
  readonly reason?: string | null;
}

export interface MemberHistoryRepository {
  record(input: MemberHistoryInput): Promise<MemberHistory>;
  listForMember(memberId: string, limit?: number): Promise<MemberHistory[]>;
}

// -----------------------------------------------------------------------------
// MemberSpecialRole
// -----------------------------------------------------------------------------

export interface MemberSpecialRoleRepository {
  listActive(memberId: string): Promise<MemberSpecialRole[]>;
  /** @returns `null` se il ruolo era gia' attivo (operazione idempotente). */
  add(
    memberId: string,
    role: SpecialRole,
    actorDiscordId: string,
  ): Promise<MemberSpecialRole | null>;
  /** @returns `false` se non c'era nessuna assegnazione attiva da rimuovere. */
  remove(memberId: string, role: SpecialRole, actorDiscordId: string): Promise<boolean>;
  /** Rimuove tutte le assegnazioni attive. Usato all'uscita dalla gang. */
  removeAll(memberId: string, actorDiscordId: string): Promise<SpecialRole[]>;
}

// -----------------------------------------------------------------------------
// Blacklist
// -----------------------------------------------------------------------------

export interface BlacklistInput {
  readonly discordId: string;
  readonly reason: string;
  readonly createdByDiscordId: string;
  readonly rpName?: string | null;
  readonly rpSurname?: string | null;
  readonly notes?: string | null;
}

export interface BlacklistRepository {
  /** @returns `null` se l'utente era gia' blacklistato (idempotente). */
  add(input: BlacklistInput): Promise<BlacklistEntry | null>;
  findActive(discordId: string): Promise<BlacklistEntry | null>;
  isBlacklisted(discordId: string): Promise<boolean>;
  /** @returns `false` se non c'era nessuna entry attiva. */
  remove(discordId: string, removedByDiscordId: string, reason?: string): Promise<boolean>;
  listActive(options?: { skip?: number; take?: number }): Promise<BlacklistEntry[]>;
  countActive(): Promise<number>;
  /** Tutte le entry, anche rimosse: e' lo storico dell'utente. */
  history(discordId: string): Promise<BlacklistEntry[]>;
}

// -----------------------------------------------------------------------------
// Audit
// -----------------------------------------------------------------------------

/** Valore serializzabile in una colonna `Json` PostgreSQL. */
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

/** Payload di `AuditLog.metadata`: sempre un oggetto, mai uno scalare. */
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface AuditInput {
  readonly action: AuditAction;
  readonly actorDiscordId?: string | null;
  readonly targetDiscordId?: string | null;
  readonly entityType?: string | null;
  readonly entityId?: string | null;
  readonly previousValue?: string | null;
  readonly newValue?: string | null;
  readonly reason?: string | null;
  readonly metadata?: JsonObject | null;
}

export interface AuditRepository {
  record(input: AuditInput): Promise<AuditLog>;
  listRecent(limit?: number): Promise<AuditLog[]>;
  listForTarget(discordId: string, limit?: number): Promise<AuditLog[]>;
}

// -----------------------------------------------------------------------------
// GuildConfig
// -----------------------------------------------------------------------------

export interface GuildConfigRepository {
  /** Legge la configurazione, creandola con i default se assente. */
  ensure(guildId: string): Promise<GuildConfig>;
  update(guildId: string, patch: Partial<Omit<GuildConfig, 'guildId'>>): Promise<GuildConfig>;
}

// -----------------------------------------------------------------------------
// PersistentPanel
// -----------------------------------------------------------------------------

export interface PersistentPanelRepository {
  find(guildId: string, panelType: PanelType): Promise<PersistentPanel | null>;
  save(input: {
    guildId: string;
    panelType: PanelType;
    channelId: string;
    messageId: string;
  }): Promise<PersistentPanel>;
  delete(guildId: string, panelType: PanelType): Promise<void>;
}

// -----------------------------------------------------------------------------
// GuildMemberSnapshot
// -----------------------------------------------------------------------------

/**
 * Lo stato Discord di un membro all'ultima osservazione.
 *
 * Volutamente ridotto ai soli campi necessari al confronto: la
 * riconciliazione ne carica uno per ogni membro della guild, e caricare
 * anche timestamp e metadati raddoppierebbe il traffico per niente.
 */
export interface GuildMemberSnapshotRow {
  readonly discordId: string;
  readonly inGuild: boolean;
  readonly roleIds: readonly string[];
  readonly rolesHash: string;
  /**
   * Nome mostrato all'ultima osservazione.
   *
   * E' l'unico modo di dire CHI ha lasciato il server: quando la
   * riconciliazione se ne accorge, il membro non e' piu' interrogabile nella
   * guild. La colonna esiste gia' a schema — nessuna migration.
   */
  readonly nickname?: string | null;
}

export interface GuildMemberSnapshotUpsert {
  readonly guildId: string;
  readonly discordId: string;
  readonly inGuild: boolean;
  readonly roleIds: readonly string[];
  readonly rolesHash: string;
  readonly nickname?: string | null;
  readonly seenAt: Date;
}

export interface GuildMemberSnapshotRepository {
  listForGuild(guildId: string): Promise<GuildMemberSnapshotRow[]>;
  countForGuild(guildId: string): Promise<number>;
  upsertMany(rows: readonly GuildMemberSnapshotUpsert[]): Promise<void>;
  /** Marca il membro come uscito, senza cancellare la riga. */
  markLeft(guildId: string, discordId: string, at: Date): Promise<void>;
}

// -----------------------------------------------------------------------------
// Aggregato
// -----------------------------------------------------------------------------

/** Tutti i repository, passati ai service come unica dipendenza. */
export interface Repositories {
  readonly profiles: DiscordProfileRepository;
  readonly verifications: VerificationRepository;
  readonly applications: TtpApplicationRepository;
  readonly members: MemberRepository;
  readonly history: MemberHistoryRepository;
  readonly specialRoles: MemberSpecialRoleRepository;
  readonly blacklist: BlacklistRepository;
  readonly audit: AuditRepository;
  readonly guildConfig: GuildConfigRepository;
  readonly panels: PersistentPanelRepository;
  readonly snapshots: GuildMemberSnapshotRepository;
}
