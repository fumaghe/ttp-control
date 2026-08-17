/**
 * Astrazione sulle operazioni Discord sui ruoli.
 *
 * I service dipendono da questa interfaccia, non da `GuildMember`. Cosi' la
 * business logic (chi puo' promuovere chi, quale rank segue quale) e'
 * testabile senza aprire una connessione a Discord, e resta un solo punto in
 * cui si chiamano davvero `roles.add` / `roles.remove`.
 */

export interface GuildMemberSnapshot {
  readonly discordId: string;
  readonly username: string;
  readonly displayName: string;
  /** ID di tutti i ruoli attualmente posseduti. */
  readonly roleIds: ReadonlySet<string>;
  /** Posizione del ruolo piu' alto: serve per la gerarchia Discord reale. */
  readonly highestRolePosition: number;
  readonly isGuildOwner: boolean;

  /**
   * L'account e' un bot. `undefined` quando la sorgente non lo sa dire.
   *
   * Opzionale di proposito: aggiungerlo come obbligatorio avrebbe rotto ogni
   * costruttore di snapshot esistente per un dato che serve solo a decidere
   * se un messaggio di benvenuto ha senso.
   */
  readonly bot?: boolean | undefined;
  /**
   * Hash dell'avatar utente (non l'URL, non l'avatar per-server).
   * `undefined` = non noto, `null` = l'utente usa l'avatar di default.
   */
  readonly avatar?: string | null | undefined;
}

/** Operazioni sui ruoli, con il controllo di gerarchia gia' incorporato. */
export interface RoleGateway {
  /** @returns `null` se l'utente non e' (piu') nella guild. */
  fetchMember(discordId: string): Promise<GuildMemberSnapshot | null>;

  /**
   * Applica un diff di ruoli in una sola chiamata all'API Discord.
   *
   * Una sola `roles.set` invece di N add/remove: evita gli stati intermedi
   * incoerenti (un membro senza nessun rank tra la rimozione e l'aggiunta) e
   * consuma un solo rate limit.
   *
   * @returns lo snapshot aggiornato.
   * @throws AppError con codice ROLE_HIERARCHY o ROLE_ASSIGNMENT_FAILED.
   */
  applyRoleDiff(
    discordId: string,
    diff: { add?: readonly string[]; remove?: readonly string[] },
    reason: string,
  ): Promise<GuildMemberSnapshot>;

  /** Il bot puo' gestire questo ruolo (esiste, non e' managed, gerarchia ok)? */
  canManageRole(roleId: string): boolean;

  /** Invia un DM, senza far fallire nulla se l'utente li ha chiusi. */
  tryNotify(discordId: string, content: { title: string; description: string }): Promise<boolean>;
}
