/**
 * Lock applicativo per-chiave.
 *
 * Serializza le operazioni sensibili sullo stesso bersaglio (tipicamente un
 * Discord ID) all'interno del processo del bot. Copre il caso concreto:
 * doppio click su un bottone, retry dell'interaction da parte di Discord,
 * due operatori che agiscono nello stesso istante.
 *
 * NON e' un lock distribuito: con piu' istanze del bot non basta. La difesa
 * definitiva resta nel database — locking ottimistico su `Member.version` e
 * unique constraint sulle colonne-sentinella. Questo mutex evita il grosso
 * delle collisioni e il lavoro sprecato, il DB garantisce la correttezza.
 */

export class KeyedMutex {
  /** Coda per chiave: l'ultima promise in attesa su quella chiave. */
  private readonly queues = new Map<string, Promise<unknown>>();

  /**
   * Esegue `task` garantendo che nessun altro task con la stessa chiave sia
   * in esecuzione contemporaneamente.
   */
  public async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();

    // `task` parte solo quando il precedente si e' concluso, in un modo o
    // nell'altro: passandolo su entrambi i rami, un fallimento a monte non
    // blocca ne' contamina chi e' in coda.
    const result = previous.then(task, task);

    // In coda registriamo una promise che non rigetta mai, altrimenti un
    // errore del task diventerebbe una unhandled rejection per il successivo.
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(key, tail);

    try {
      return await result;
    } finally {
      // Se nel frattempo non si e' accodato nessuno, la coda siamo ancora noi:
      // rimuoviamo la chiave per non far crescere la mappa indefinitamente.
      if (this.queues.get(key) === tail) this.queues.delete(key);
    }
  }

  /** Numero di chiavi con operazioni in coda. Utile nei test. */
  public get size(): number {
    return this.queues.size;
  }
}

/**
 * Mutex condiviso per le operazioni di membership.
 * La chiave e' sempre `<operazione>:<discordId del bersaglio>`.
 */
export const memberMutex = new KeyedMutex();

/** Costruisce una chiave di lock coerente. */
export function lockKey(scope: string, discordId: string): string {
  return `${scope}:${discordId}`;
}
