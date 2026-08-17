# TTP Control

Bot Discord gestionale per la gang FiveM GTA RP **TTP — Impero**.

Non è una raccolta di comandi scollegati: è un piccolo gestionale interno con
audit trail, permission matrix applicativa e stato persistito su PostgreSQL.

> **Stato del progetto:** V2 — la stessa V1, su Cloudflare Workers.
> Verify, candidature TTP, gestione membri, roster, community, blacklist,
> control panel, audit, permission matrix, consistency check.
>
> Il bot gira su **Discord HTTP Interactions + Cloudflare Workers + Cron
> Triggers + Neon**: nessuna VPS, nessun processo Node persistente, piano
> gratuito Cloudflare. La business logic è invariata rispetto alla V1 — è
> cambiato solo come il bot viene raggiunto e come viene eseguito.
> Il vecchio deployment Gateway/Docker resta documentato in
> [`deployment/legacy-gateway/`](deployment/legacy-gateway/README.md).

---

## Verified ≠ TTP

Questa è **la** distinzione fondamentale del progetto. Non va mai confusa.

| | `✅ Verified` | `🩸 TTP` |
| --- | --- | --- |
| Significato | Ha completato la verifica del Discord | È membro effettivo della gang |
| Come si ottiene | Submit valido del modal di verifica | Approvazione della Leadership |
| Serve approvazione? | **No** | **Sì** |
| Accesso | STREET, CHILL ZONE | + THE HOUSE, GANG INFO, STASH |

```text
Utente entra nel Discord
        ↓
Completa Verify
        ↓
✅ Verified                    ← nessuna approvazione richiesta
        ↓
Accesso Community / Street / Chill
        ↓
Candidatura TTP
        ↓
Leadership APPROVE
        ↓
🩸 TTP + rank iniziale (Resident)
```

Invarianti applicate dal sistema:

- `TTP ⇒ Verified` — ma `Verified ⇏ TTP`
- `Rank TTP ⇒ TTP` — nessun rank senza membership
- Un membro TTP ha **esattamente un** rank
- Dopo `/member remove` l'utente **resta** Verified
- Dopo il rifiuto di una candidatura l'utente **resta** Verified

---

## Architettura

```text
Discord
   │  HTTP Interaction (POST, firmata Ed25519)
   ▼
Cloudflare Worker  ──────────────────────────────┐
   │  verifica firma → 401 se non valida         │
   ▼                                             │
Interaction Router                               │  Cron Trigger  */5 * * * *
   │                                             ▼
   ▼                                    MemberReconciliationService
Services  (regole di dominio, invariate)         │
   │                                             │
   ├───────────────► DiscordGateway ─────────────┤
   │                 (DiscordRestGateway)        │
   ▼                        │                    │
Repositories                ▼                    │
   │                 Discord REST API ◄──────────┘
   ▼
Prisma 7 + @prisma/adapter-pg
   │
   ▼
Cloudflare Hyperdrive → Neon PostgreSQL
```

Tre punti che definiscono la V2:

1. **Nessun Gateway.** Le interaction arrivano come richieste HTTP firmate.
   Ogni operazione Discord passa dalla REST API attraverso un solo adapter.
2. **Nessuno stato in memoria.** Ogni invocazione parte da zero. Tutto ciò che
   deve sopravvivere sta a database — inclusi i pannelli persistenti e gli
   snapshot dei membri.
3. **I tre eventi di membership diventano un cron.** `guildMemberAdd`,
   `guildMemberRemove` e `guildMemberUpdate` non esistono più: la
   riconciliazione periodica li deduce confrontando lo stato Discord con
   l'ultimo snapshot.

---

## Requisiti

| Componente | Versione | Note |
| --- | --- | --- |
| Node.js | **≥ 22.12** (LTS) | per gli script locali e la Prisma CLI |
| npm | ≥ 10 | incluso con Node 22 |
| Account Cloudflare | piano **Free** | Workers + Cron + Hyperdrive |
| PostgreSQL | 16+ | fornito da Neon |
| Git | qualsiasi recente | |

Stack applicativo:

| Pacchetto | Versione | Ruolo |
| --- | --- | --- |
| `typescript` | 6.0.3 | vedi nota sotto |
| `@discordjs/builders` | 1.14.1 | builder di embed, bottoni, modal, comandi |
| `discord-api-types` | 0.38.53 | tipi ed enum dell'API Discord |
| `prisma` / `@prisma/client` | 7.9.1 | ORM + CLI |
| `@prisma/adapter-pg` | 7.9.1 | driver adapter PostgreSQL |
| `wrangler` | 4.123.0 | CLI Cloudflare Workers |
| `eslint` | 10.8.1 | + `typescript-eslint` 8.67.0 |
| `prettier` | 3.9.6 | formattazione |
| `vitest` | 4.1.10 | test |

`discord.js` **non è più una dipendenza**. Il pacchetto completo porta con sé
WebSocket, `zlib` e la cache della guild: cose che sulla runtime dei Worker non
funzionano e che, comunque, servivano solo al Gateway. Restano i *builder*
(`@discordjs/builders`), che sono JavaScript puro e girano identici ovunque —
quindi tutti i componenti della V1 sono rimasti invariati.

Anche `pino` è stato sostituito: dipende da `worker_threads` e dagli stream di
Node. Al suo posto c'è un logger strutturato minimale con la stessa API e le
stesse garanzie di redazione dei secret (`src/utils/logger.ts`).

### Nota su TypeScript 6 vs 7

L'ultima release di TypeScript è la **7.0.2** (il port nativo in Go), ma
`typescript-eslint@8.67.0` dichiara `peerDependencies.typescript: ">=4.8.4 <6.1.0"`:
**non supporta ancora TypeScript 7**.

Il progetto usa quindi **TypeScript 6.0.3** — l'ultima release stabile
compatibile con il linting type-aware. Quando `typescript-eslint` pubblicherà
il supporto a TS 7 basterà aggiornare entrambi insieme; il resto della codebase
non richiede modifiche.

---

## Installazione

```bash
git clone git@github.com:fumaghe/ttp-control.git
cd ttp-control
npm install          # `postinstall` esegue automaticamente `prisma generate`
```

Poi vedi **[Cosa devi fare tu](#cosa-devi-fare-tu)** per la configurazione
completa di Cloudflare, Discord e Neon.

---

## Configurazione

La configurazione vive in tre posti diversi, per una ragione precisa:

| Dove | Cosa | Perché lì |
| --- | --- | --- |
| `wrangler.jsonc` → `vars` | ID di ruoli, canali, guild, client, owner | Non sono segreti: identificano oggetti di un server privato e non danno accesso a nulla. Versionarli rende il deploy riproducibile. |
| Wrangler secrets | `DISCORD_TOKEN`, `DISCORD_PUBLIC_KEY`, eventuale `DATABASE_URL` | Sono credenziali. Cloudflare le cifra e non compaiono mai in un file del repository. |
| `.env` (solo locale) | tutto, per gli script Node | Serve a `npm run commands:deploy` e alla Prisma CLI, che girano sulla tua macchina. |

```bash
# Secret di produzione — mai in wrangler.jsonc
npx wrangler secret put DISCORD_TOKEN
npx wrangler secret put DISCORD_PUBLIC_KEY
```

`.env.example` documenta ogni variabile. `.env` e `.dev.vars` sono in
`.gitignore` e non devono mai finire nel repository.

Il codice legge la configurazione esclusivamente tramite `src/config/env.ts`:
**non esistono snowflake hardcoded nei service**, e i ruoli non vengono mai
cercati per nome.

### `DISCORD_PUBLIC_KEY` — non è il bot token

È la variabile nuova della V2, e l'errore più facile da fare è confonderla con
il token.

| | `DISCORD_TOKEN` | `DISCORD_PUBLIC_KEY` |
| --- | --- | --- |
| Cosa fa | autentica il bot verso Discord | verifica che una richiesta venga davvero da Discord |
| Dove si trova | Developer Portal → **Bot** → Reset Token | Developer Portal → **General Information** → Public Key |
| Che aspetto ha | tre segmenti separati da punto | 64 caratteri esadecimali, senza punti |
| Se lo perdi | vai in panico e resettalo | niente, è pubblica |

Senza `DISCORD_PUBLIC_KEY` il Worker non può distinguere una interaction
autentica da un POST inviato da chiunque conosca l'URL dell'endpoint. È
l'**unica** autenticazione che quell'endpoint ha.

---

## Database — Neon + Prisma 7

### I due endpoint Neon

Neon espone due host per lo stesso database:

| Endpoint | Host | Usato da |
| --- | --- | --- |
| **Pooled** | `ep-xxx-**pooler**.<region>.aws.neon.tech` | il bot a runtime |
| **Direct** | `ep-xxx.<region>.aws.neon.tech` | la Prisma CLI (migrate/studio) |

Il pooler di Neon è basato su PgBouncer in transaction mode: le operazioni DDL
delle migration non ci passano in modo affidabile. Per questo la CLI usa
`DIRECT_URL`, mentre il processo long-running del bot usa `DATABASE_URL`.

Entrambe le stringhe devono terminare con `?sslmode=require`.

Dove trovarle: Neon Console → progetto → **Connection Details**, alternando il
toggle *Pooled connection*.

### Perché non esiste più `directUrl` nello schema

Con **Prisma 7** il blocco `datasource` dello schema non accetta più `url` né
`directUrl` — sono stati rimossi. La connection string della CLI si dichiara in
`prisma.config.ts`:

```ts
datasource: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL }
```

`DIRECT_URL` resta quindi nel `.env`, ma con un ruolo diverso rispetto a Prisma 6:
non è più un campo dello schema, è la sorgente dell'URL per la CLI. Se non viene
impostato, la CLI ricade su `DATABASE_URL` (funziona, ma le migration attraverso
il pooler possono fallire — meglio configurarlo).

`prisma.config.ts` non lancia se l'URL manca, così `prisma generate` funziona
anche in build CI/Docker senza database.

### Altre conseguenze di Prisma 7

- Generator `prisma-client` (non più `prisma-client-js`), con `output` obbligatorio.
- Il client viene generato come **sorgente TypeScript** in `src/generated/prisma/`,
  impacchettata insieme al progetto. È un artefatto di build: è in `.gitignore`
  ed escluso da ESLint.
- `importFileExtension = "js"` fa emettere import ESM `./enums.js`.
- Il client richiede un **driver adapter**: `@prisma/adapter-pg`.

### Database su Cloudflare — la scelta e il perché

`runtime = "workerd"` nel generator è la riga che rende possibile tutto il
resto. Con quella impostazione Prisma emette il query compiler come **modulo
WebAssembly vero** (`query_compiler_fast_bg.wasm`), che wrangler impacchetta
insieme al Worker.

È la differenza fra funzionare e non funzionare: il client generato per Node
incorpora lo stesso compiler come stringa base64 e lo compila a runtime con
`WebAssembly.compile()`. Sulla runtime dei Worker la compilazione dinamica di
WebAssembly è **vietata**. Il bundle si costruirebbe lo stesso, e fallirebbe
alla prima query.

Il percorso scelto è quindi quello documentato da Prisma per Cloudflare:

```text
Repositories → Prisma 7 (client workerd) → @prisma/adapter-pg → Hyperdrive → Neon
```

**Perché Hyperdrive.** Un Worker non mantiene connessioni fra due invocazioni:
senza un pooler davanti, ogni interaction aprirebbe una connessione TCP nuova
verso Neon, pagando l'handshake TLS ogni volta e consumando il limite di
connessioni del progetto. Hyperdrive tiene il pool lato Cloudflare ed è
gratuito sul piano Free. Il Worker riceve la connection string dal binding, e
`DATABASE_URL` resta come fallback per `wrangler dev` senza binding.

**Cosa NON è cambiato**, ed è il punto: il database Neon è lo stesso, lo schema
è lo stesso, le migration esistenti sono intatte, e le interfacce dei
repository non sono state toccate. Hyperdrive è un pooler davanti a Neon, non
un altro database. Nessuna migrazione a D1, nessun nuovo database.

**Il costo di questa scelta.** Il query compiler WebAssembly pesa ~3,7 MB
(~1,2 MB compressi) e il bundle completo arriva a ~1,5 MB compressi, contro il
limite di 3 MiB del piano gratuito. C'è margine, ma non è illimitato: la CI
verifica la dimensione a ogni build, così un superamento si scopre in pipeline
e non al momento del deploy.

**L'alternativa che abbiamo scartato** era il driver HTTP di Neon con SQL
scritta a mano: bundle molto più piccolo, ma avrebbe richiesto di riscrivere
tutti e undici i repository e di rinunciare alla garanzia che schema e query
restino allineati. Non valeva il risparmio.

### Migrations

```bash
npm run prisma:migrate            # crea e applica una migration (sviluppo)
npm run prisma:migrate:deploy     # applica le migration pendenti (produzione)
npm run prisma:generate           # rigenera il client
npm run prisma:studio             # GUI sul database
```

Le migration sono versionate in `prisma/migrations/` e vanno committate.

---

## Sviluppo

```bash
npm run worker:dev     # wrangler dev — Worker in locale
npm run worker:tail    # log in streaming dal Worker in produzione
npm run typecheck      # tsc su entrambi i progetti (condiviso + Worker)
npm run lint           # ESLint (type-aware)
npm run lint:fix       # ESLint con autofix
npm run format         # Prettier --write
npm run format:check   # Prettier --check
npm test               # Vitest
npm run test:watch     # Vitest in watch
npm run test:coverage  # Vitest + coverage v8
npm run check          # typecheck + lint + format:check + test
```

`npm run check` è il gate da eseguire prima di ogni commit.

### Esporre il Worker locale a Discord

`wrangler dev` ascolta su `http://localhost:8787`, ma Discord deve poter
raggiungere l'endpoint da internet: serve un tunnel.

```bash
# Terminale 1
cp .dev.vars.example .dev.vars   # poi compila i secret
npm run worker:dev

# Terminale 2 — tunnel pubblico
npx cloudflared tunnel --url http://localhost:8787
#   → https://qualcosa-di-casuale.trycloudflare.com
```

Incolla `https://<tunnel>/interactions` come **Interactions Endpoint URL** nel
Developer Portal. Discord invia subito un PING firmato: se il Worker locale
risponde `{"type":1}`, la configurazione è corretta.

> Attenzione: l'Interactions Endpoint URL è **uno solo** per applicazione.
> Mentre punta al tunnel, la produzione non riceve interaction. Per sviluppare
> senza interferenze conviene una seconda applicazione Discord di test, con il
> suo token e la sua Public Key.
>
> L'URL di `cloudflared` cambia a ogni avvio: va reincollato ogni volta.

Il tunnel serve solo alle interaction. Il **Cron Trigger non parte** in
`wrangler dev`: per provarlo si usa l'endpoint di test di wrangler:

```bash
npx wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"
```

## Build e validazione del bundle

```bash
npm run build          # prisma generate + build del Worker
npm run worker:build   # wrangler deploy --dry-run --outdir dist/worker
```

`worker:build` esegue esattamente lo stesso bundling del deploy, senza
pubblicare nulla e senza credenziali Cloudflare: è quello che gira in CI.

## Deploy degli slash command

```bash
npm run commands:deploy
```

Registrazione per-guild (`GUILD_ID`): la propagazione è immediata, a differenza
dei comandi globali. Lo script usa lo stesso client REST del Worker — nessun
Gateway, nessun processo persistente.

Va rieseguito solo quando cambiano **nome, descrizione o opzioni** di un
comando; il deploy del Worker da solo non aggiorna la definizione dei comandi
lato Discord.

---

## Comandi

Tutti i comandi rispondono in **ephemeral** quando mostrano dati amministrativi:
note della Leadership, motivazioni e dettagli di blacklist non finiscono mai in
un canale pubblico.

### Pubblici

| Comando | Cosa fa |
| --- | --- |
| `/ping` | Latenza Discord REST, stato del database, uptime dell’isolate |
| `/apply ttp` | Invia una candidatura d'ingresso nella gang |
| `/apply cancel` | Ritira la propria candidatura in attesa |
| `/apply status` | Storico delle proprie candidature |
| `/roster` | Elenco dei membri per rank, con filtri e paginazione |

### Leadership

| Comando | Cosa fa | Minimo |
| --- | --- | --- |
| `/setup check` | Verifica ruoli, canali, permessi, gerarchia, database | OG |
| `/setup verify-panel` | Pubblica (o aggiorna) il pannello di verifica | OG |
| `/setup control-panel` | Pubblica (o aggiorna) il control panel | OG |
| `/member info` | Scheda del membro con azioni rapide | tutti |
| `/member add` | Ingresso manuale nella gang | Big |
| `/member promote` | Rank successivo | Big |
| `/member demote` | Rank precedente | Big |
| `/member rank` | Cambio rank diretto | Big |
| `/member roles` | Badge e specializzazioni | Big |
| `/member status` | Stato di membership | tutti |
| `/member inactive` / `active` | Cambio stato | Big |
| `/member remove` | Uscita dalla gang (**non** dal Discord) | Big |
| `/member permadeath` | Permadeath, con conferma esplicita | OG |
| `/community list` | Verificati, friend, mafia | tutti |
| `/community info` | Dossier completo su un utente | tutti |
| `/community verified` | Assegna o revoca Verified a mano | Big |
| `/community friend` / `mafia` | Ruoli di relazione | Big |
| `/community revoke` | Revoca l'accesso community | Big |
| `/community makettp` | Ingresso nella gang dalla community | Big |
| `/blacklist add` / `remove` / `info` / `list` | Blacklist | Big* |
| `/panel` | Control panel effimero | Big* |
| `/system sync-check` | Report di integrità Discord ↔ database | OG |

\* configurabile nella policy della guild.

### Interazioni

| Componente | Dove |
| --- | --- |
| 🔐 `VERIFY` + modal | pannello nel canale verify |
| ✅ `APPROVE TTP` / ❌ `REJECT` / 🚫 `BLACKLIST` | canale candidature |
| ⬆ `PROMOTE` / ⬇ `DEMOTE` / 🎭 `ROLES` / 💤 `STATUS` / 📝 `NOTES` / 🚪 `REMOVE` | member card |
| 👥 `MEMBERS` / 🏙 `COMMUNITY` / 📋 `ROSTER` / 📨 `TTP REQUESTS` / 🔍 `SEARCH` / 🚫 `BLACKLIST` | control panel |
| ◀️ ▶️ paginazione | roster |

**Ogni click ricontrolla i permessi.** Un pannello generato in passato da un OG
non autorizza chi ci clicca sopra adesso.

---

## Struttura del progetto

```text
ttp-control/
├── wrangler.jsonc           # configurazione Worker: vars, cron, Hyperdrive
├── prisma/
│   ├── schema.prisma        # modelli + enum di dominio
│   └── migrations/
├── deployment/
│   └── legacy-gateway/      # Docker della V1 + istruzioni di rollback
├── scripts/
│   └── deploy-commands.ts   # registrazione slash command via REST
├── src/
│   ├── worker/              # entrypoint Cloudflare: fetch() e scheduled()
│   ├── http/                # firma Ed25519, InteractionContext, responder, router
│   ├── discord/             # client REST, DiscordRestGateway, audit sink, payload
│   ├── commands/            # slash command, per dominio
│   ├── interactions/        # registry + button / modal / select handler
│   ├── services/            # business logic (invariata dalla V1)
│   ├── repositories/        # accesso dati (unico strato che tocca Prisma)
│   ├── components/          # embed, button, modal, select riutilizzabili
│   ├── config/              # env validation, ruoli, canali, permessi
│   ├── database/            # Prisma client + adapter
│   ├── errors/              # errori applicativi tipizzati
│   ├── types/
│   ├── utils/               # logger, helper
│   └── generated/prisma/    # client generato (non versionato)
└── tests/
    ├── support/             # harness in memoria, fixture Discord
    └── unit/
```

Cosa è cambiato rispetto alla V1, cartella per cartella:

| V1 | V2 | |
| --- | --- | --- |
| `src/index.ts` | `src/worker/index.ts` | processo → `fetch()` + `scheduled()` |
| `src/client/` | `src/discord/` | client discord.js → adapter REST |
| `src/events/` | `src/services/memberReconciliationService.ts` | eventi Gateway → cron |
| — | `src/http/` | firma, DTO, responder, router: tutto nuovo |
| `src/services/`, `src/repositories/`, `src/config/` | invariati | è il punto della migrazione |

### Direzione delle dipendenze

```text
Discord Interaction
        ↓
Interaction Handler      ← nessuna business logic qui
        ↓
Validation → Authorization
        ↓
Service                  ← tutte le regole di dominio
        ↓
Repository               ← unico strato che parla con Prisma
        ↓
Prisma → PostgreSQL / Neon
```

Ogni operazione amministrativa segue la stessa sequenza:

```text
VALIDATE → AUTHORIZE → CHECK CURRENT STATE → EXECUTE → PERSIST → AUDIT → RESPOND
```

Regole strutturali applicate anche via ESLint:

- Nessuna query nei handler Discord.
- `process.env` è leggibile solo da `src/config/env.ts` e `src/utils/logger.ts`
  (`no-restricted-properties`).
- `console.*` è vietato nel codice di runtime (`no-console`): si usa il logger,
  che redige i secret.

---

## Permessi Discord richiesti

Il bot **non** richiede `Administrator`.

| Permesso | Perché |
| --- | --- |
| View Channels | leggere i canali gestiti |
| Send Messages | pannelli, log, risposte |
| Embed Links | embed |
| Read Message History | recuperare i pannelli persistenti |
| Manage Roles | assegnare Verified, TTP, rank, badge |
| Manage Nicknames | allineare i nickname al nome IC |
| Use Application Commands | slash command |

### Posizione del ruolo del bot

Discord non permette di gestire ruoli **pari o superiori** al proprio ruolo più
alto. Il ruolo del bot deve stare **sopra tutti i ruoli che gestisce**, quindi
sopra `👑 OG`, e sotto i ruoli di staff umano che non deve toccare.

`/setup` (Phase 2) verifica questa condizione e segnala esattamente quali ruoli
non sono gestibili.

## Server Members Intent (serve ancora)

Senza Gateway non ci sono più *intents* nel senso della connessione
WebSocket — ma **`Server Members Intent` resta obbligatorio**, ed è
controintuitivo abbastanza da meritare una riga:

> `GET /guilds/{id}/members` è un endpoint REST, e Discord lo protegge con lo
> stesso intent privilegiato del Gateway.

Va quindi lasciato attivo in **Developer Portal → Bot → Privileged Gateway
Intents → Server Members Intent**. Senza, la riconciliazione periodica non può
enumerare i membri e il bot smette di accorgersi di chi entra ed esce.

`Message Content` resta **non** abilitato: il bot non legge i messaggi degli
utenti.

`/setup check` verifica l'intent provando davvero l'enumerazione.

---

## Sicurezza

### Superficie HTTP (nuova nella V2)

Il Worker espone un endpoint pubblico su internet. Chiunque ne conosca l'URL
può inviarci una richiesta: è la differenza sostanziale rispetto al Gateway,
dove il canale era autenticato dal token una volta sola all'avvio.

| Controllo | Dove | Cosa impedisce |
| --- | --- | --- |
| Firma Ed25519 obbligatoria | `src/http/signature.ts` | richieste non provenienti da Discord |
| Verifica sul corpo **grezzo** | `src/worker/index.ts` | manomissione del payload con un JSON riserializzato |
| Finestra sul timestamp (5 min) | `src/http/signature.ts` | replay di una richiesta valida catturata |
| Risposta 401 indistinguibile | `src/worker/index.ts` | far capire a chi sonda quanto si è avvicinato |
| Guild ID validato | `src/http/router.ts` | applicare la configurazione di questo server altrove |
| `customId` validato | `src/utils/customId.ts` | namespace, azioni e argomenti arbitrari da un client manipolato |
| Authorization a **ogni** click | `src/services/authorizationService.ts` | riuso di un pannello pubblicato da un OG |
| Ruoli e canali solo da config | `src/config/` | ID arbitrari presi dal payload → SSRF / privilege escalation |
| URL Discord costruiti in un solo posto | `src/discord/rest.ts` | richieste verso host arbitrari |
| Bot token mai sugli endpoint webhook | `src/http/responder.ts` | esposizione gratuita della credenziale |
| Rate limit gestito con tetto ai retry | `src/discord/rest.ts` | loop di retry che brucia il budget |
| Secret redatti nei log | `src/utils/logger.ts` | token e connection string in `wrangler tail` |

Due punti che vale la pena rendere espliciti:

- **Nessun ID arbitrario dal payload.** Il Worker non assegna mai un ruolo o
  scrive mai in un canale il cui ID arriva dalla richiesta. Ruoli e canali
  vengono esclusivamente dal registry costruito sulla configurazione. Un
  `customId` può contenere un Discord ID *bersaglio*, che viene rivalidato
  come snowflake e passato all'authorization prima di qualsiasi effetto.
- **Nessuna fiducia nelle risposte di Discord.** Il gateway REST tratta i
  payload dell'API come ipotesi da validare, non come tipi garantiti: un
  membro senza `user`, un ruolo mancante o un messaggio cancellato producono
  un percorso gestito, non un crash.

### Checklist prima della produzione

### Se un secret viene esposto

Un secret comparso in un commit, in un log o in una condivisione va considerato
**compromesso**, anche se il repository è privato. Rimuoverlo dal codice non
basta: resta nella history di git.

- **Discord token** → Developer Portal → Bot → *Reset Token*
- **Password Neon** → Neon Console → *Reset password* del ruolo, poi aggiornare
  `DATABASE_URL`, `DIRECT_URL` e la configurazione Hyperdrive
  (`npx wrangler hyperdrive update <id> --connection-string="..."`)

La `DISCORD_PUBLIC_KEY` non è un segreto: se finisce in un log non c'è nulla
da fare. Serve a *verificare* firme, non a produrle.

### Permission matrix

L'autorizzazione **non** si appoggia solo alle Discord permission: esiste una
matrice applicativa (`src/config/permissions.ts`, Phase 2+).

| Operazione | OG | Big | Young OG | Gangster / Resident |
| --- | :-: | :-: | :-: | :-: |
| roster | ✅ | ✅ | ✅ | ✅ |
| member info | ✅ | ✅ | ✅ | ✅ |
| review candidature TTP | ✅ | ✅ | configurabile | ❌ |
| add TTP | ✅ | ✅ | ❌ | ❌ |
| promote / demote | ✅ | limitato | ❌ | ❌ |
| rank diretto | ✅ | limitato | ❌ | ❌ |
| special roles | ✅ | ✅ | ❌ | ❌ |
| inactive / active | ✅ | ✅ | ❌ | ❌ |
| remove TTP | ✅ | ✅ | ❌ | ❌ |
| blacklist | ✅ | configurabile | ❌ | ❌ |
| permadeath | ✅ | ❌ | ❌ | ❌ |
| control panel | ✅ | configurabile | ❌ | ❌ |

Regole non negoziabili:

- Big **non** può amministrare OG.
- Di default Big **non** può amministrare un altro Big.
- `OWNER_ID` ha sempre accesso amministrativo completo.
- Oltre alla matrice si controlla sempre la gerarchia Discord reale.

---

## Backup

Il database è PostgreSQL gestito da Neon: **non esistono file `.db` da copiare**,
e nessuna strategia di backup deve basarsi sulla copia di file.

Livelli disponibili, da verificare rispetto al piano Neon effettivamente attivo:

1. **History / point-in-time restore** — Neon mantiene una finestra di history
   che permette di ripristinare il branch a un istante passato. La durata della
   finestra dipende dal piano: controllarla in console prima di considerarla una
   garanzia.
2. **Branch di sicurezza** — creare un branch Neon prima di ogni migration
   rischiosa è la rete di sicurezza più economica ed è istantanea.
3. **Export logico periodico** — dump indipendente dal provider:

   ```bash
   pg_dump "$DIRECT_URL" --format=custom --no-owner --no-privileges \
     --file="ttp-control-$(date +%F).dump"
   ```

   ```bash
   pg_restore --dbname="$DIRECT_URL" --clean --if-exists ttp-control-YYYY-MM-DD.dump
   ```

   Usare `DIRECT_URL`: un dump attraverso il pooler può fallire.

Regole: la connection string arriva **sempre** dall'ambiente, mai hardcoded in
uno script di backup; i dump contengono dati personali dei membri e vanno
trattati come materiale sensibile; un backup non testato non è un backup —
verificare periodicamente il restore su un branch Neon usa e getta.

---

## Riconciliazione periodica (Cron Trigger)

Senza Gateway, i tre eventi di membership della V1 non esistono più. Al loro
posto un Cron Trigger ogni 5 minuti confronta lo stato Discord con l'ultimo
snapshot salvato e ne **deduce** gli stessi eventi.

| Evento Gateway (V1) | Come viene dedotto (V2) |
| --- | --- |
| `guildMemberAdd` | Discord ID presente ora, assente (o `inGuild = false`) nello snapshot |
| `guildMemberRemove` | ID nello snapshot con `inGuild = true`, assente dall'enumerazione |
| `guildMemberUpdate` | `rolesHash` diverso da quello registrato |

Lo snapshot vive nella tabella `guild_member_snapshots` (modello
`GuildMemberSnapshot`). Non duplica `DiscordProfile`: quello è l'anagrafica
applicativa, questo è lo stato Discord grezzo, tenuto al solo scopo di
calcolare un diff.

**Le regole di dominio sono identiche alla V1:**

- un nuovo arrivato non riceve **nessun** ruolo: la verifica resta volontaria;
- chi rientra viene controllato contro la blacklist, che è autorevole a
  database — uscire e rientrare non la aggira;
- chi esce dal Discord **non** viene rimosso dalla gang: si emette
  `MEMBER_LEFT_DISCORD`, più un `ROLE_SYNC_WARNING` se era un membro TTP, e la
  decisione resta alla Leadership;
- una modifica manuale dei ruoli produce un `ROLE_SYNC_WARNING` con
  `autoCorrected: false`. **Nessuna correzione automatica**, mai.

Tre proprietà che rendono il cron sicuro da ripetere:

1. **Seed silenzioso.** Alla prima esecuzione su una guild senza snapshot lo
   stato viene fotografato *senza* emettere eventi di join — altrimenti il
   primo cron inonderebbe l'audit con un `MEMBER_JOINED_DISCORD` per ogni
   membro già presente.
2. **Isolamento degli errori.** Ogni membro è indipendente: se il suo
   trattamento fallisce, il suo snapshot **non** viene aggiornato e la
   prossima esecuzione riprova. Uno stato avanzato per qualcosa che non è
   successo sarebbe una corruzione silenziosa.
3. **Idempotenza.** Una seconda esecuzione senza cambiamenti non produce
   nessun evento.

Il cron è la ragione per cui il progetto sta comodamente nel piano gratuito:
288 esecuzioni al giorno, ognuna con una manciata di richieste (l'enumerazione
dei membri è paginata a 1000 per pagina — per una guild privata è una sola
pagina) e una query di lettura più le upsert dei soli membri osservati.

Cambiare la frequenza significa modificare `triggers.crons` in
`wrangler.jsonc` e rifare il deploy.

---

## Deployment

Target: **Cloudflare Workers, piano gratuito**. Nessuna VPS, nessun container,
nessun processo da sorvegliare.

```bash
npm run worker:deploy
```

Il deploy produce un URL del tipo:

```text
https://ttp-control.<tuo-account>.workers.dev
```

L'endpoint da dare a Discord è quell'URL con `/interactions` in fondo.

### Interactions Endpoint URL

Dopo il primo deploy, nel Developer Portal:

```text
Discord Developer Portal
  → la tua Application
  → General Information
  → Interactions Endpoint URL
  → https://ttp-control.<account>.workers.dev/interactions
  → Save Changes
```

Al salvataggio Discord invia **immediatamente un PING firmato**. Il Worker lo
verifica e risponde `{"type": 1}`; se la firma non torna, Discord rifiuta
l'URL con un errore esplicito. Non c'è niente da fare a mano: il PING è
gestito prima di qualunque altra logica, e non tocca né il database né la rete.

Se il salvataggio fallisce, nel 99% dei casi `DISCORD_PUBLIC_KEY` è sbagliata
o non è stata caricata — vedi [Troubleshooting](#troubleshooting).

### Aggiornamenti

```bash
git pull
npm run prisma:migrate:deploy   # solo se ci sono nuove migration
npm run worker:deploy
```

Cloudflare fa lo switch atomicamente: nessuna finestra di downtime, nessun
restart da coordinare. I bottoni dei pannelli pubblicati **prima** del deploy
continuano a funzionare, perché il loro `customId` non contiene stato volatile
e tutto ciò che serve a servirli sta a database.

### Osservabilità

```bash
npm run worker:tail            # log in streaming
npx wrangler deployments list  # storico dei deploy
npx wrangler rollback          # torna al deploy precedente
```

I log sono JSON strutturato con i secret già redatti (vedi
`src/utils/logger.ts`). `observability.enabled` in `wrangler.jsonc` li rende
consultabili anche dalla dashboard.

### Differenze percepibili rispetto al Gateway

| | Gateway (V1) | Workers (V2) |
| --- | --- | --- |
| Presenza del bot | risulta **Online** | nessuna presenza |
| Latenza di risposta | costante | primo colpo leggermente più lento (cold start) |
| Eventi membri | istantanei | entro 5 minuti |
| Costo | VPS | gratuito |
| Comandi, pannelli, permessi | — | **identici** |

L'assenza dello stato *Online* è l'unica cosa che gli utenti notano: è
intrinseca alle HTTP Interactions, non un limite dell'implementazione.

## CI

`.github/workflows/ci.yml` esegue su ogni push e PR, senza bisogno di alcun
secret:

| Step | Cosa verifica |
| --- | --- |
| `prisma generate` | il client `workerd` si genera, wasm incluso |
| `prisma validate` | lo schema è valido |
| `npm run typecheck` | entrambi i progetti: condiviso (Node) e Worker (Cloudflare) |
| `npm run lint` | ESLint type-aware su tutto, Worker compreso |
| `npm run format:check` | Prettier |
| `npm test` | l'intera suite |
| `wrangler deploy --dry-run` | il bundle del Worker si costruisce davvero |
| check dimensione bundle | resta sotto i 3 MiB compressi del piano gratuito |
| `npm audit --omit=dev` | vulnerabilità nelle dipendenze di produzione |

Il dry-run è la validazione che conta: esegue lo stesso bundling del deploy —
risoluzione dei moduli, `nodejs_compat`, wasm del query compiler — e fallisce
sulle stesse cose su cui fallirebbe `wrangler deploy`.

---

## Troubleshooting

**Discord rifiuta l'Interactions Endpoint URL**
Nell'ordine: (1) `DISCORD_PUBLIC_KEY` è il valore di *General Information →
Public Key*, non il bot token; (2) è stata caricata come secret
(`npx wrangler secret list` deve elencarla); (3) il deploy successivo al
caricamento del secret è stato fatto; (4) l'URL finisce con `/interactions`.
Prova prima `curl https://<worker>/interactions` — deve rispondere con un
messaggio di health check, non con un errore.

**Ogni interaction risponde "L'applicazione non ha risposto"**
Vuol dire che il Worker non ha risposto entro 3 secondi. Guarda
`npm run worker:tail`: quasi sempre è il database irraggiungibile
(Hyperdrive mal configurato, o `DATABASE_URL` assente senza binding). Il
responder emette comunque un deferred automatico a 2,2 s, quindi il caso in
cui l'utente vede quel messaggio significa che il Worker è morto prima.

**`worker misconfigured` con HTTP 500**
Una variabile obbligatoria manca o è malformata. `npm run worker:tail` mostra
l'elenco completo dei problemi — senza mai stampare i valori dei secret.

**Il Cron non sembra girare**
`npx wrangler deployments list` per confermare il deploy, poi la dashboard
Cloudflare → Workers → il tuo Worker → *Cron Events*. In `wrangler dev` il
cron **non** parte da solo: serve `--test-scheduled`.

**Il cron gira ma non rileva niente**
Se `guild_member_snapshots` era vuota, la prima esecuzione è un seed
silenzioso per costruzione: fotografa e basta. Dalla seconda in poi rileva i
cambiamenti.

**`Missing Access` o zero membri nell'enumerazione**
`Server Members Intent` non è attivo. Serve **anche** senza Gateway, perché
protegge l'endpoint REST `GET /guilds/{id}/members`. `/setup check` lo
diagnostica.

**Il deploy fallisce per dimensione del bundle**
Il piano gratuito si ferma a 3 MiB compressi. Il bundle attuale è ~1,5 MiB, quindi
il problema è quasi certamente una dipendenza appena aggiunta. `npm run worker:build`
e poi `gzip -9 -c dist/worker/index.js | wc -c` per misurare.

**`prisma migrate` si blocca o fallisce con errori di advisory lock**
Stai migrando attraverso il pooler. Imposta `DIRECT_URL` con l'endpoint senza
`-pooler`. Le migration si applicano **sempre** dalla tua macchina verso Neon,
mai dal Worker.

**`Cannot find module '../generated/prisma/client.js'`**
Il client non è stato generato: `npm run prisma:generate`.

**`Missing Permissions` assegnando un ruolo**
Il ruolo del bot è sotto il ruolo che sta cercando di assegnare. Spostalo sopra
`👑 OG`. `/setup check` indica esattamente quali ruoli non sono gestibili.

**Gli slash command non compaiono**
`npm run commands:deploy`. Il deploy del Worker non registra i comandi: sono
due cose separate.

**Il pannello di verifica si duplica dopo un deploy**
Non dovrebbe: i pannelli sono tracciati in `PersistentPanel` (`channelId` +
`messageId`) e `/setup verify-panel` aggiorna quello esistente. Se il record è
stato perso, cancella il messaggio orfano e ripubblica.

**`npm audit` segnala `deepmerge-ts`**
Vulnerabilità transitiva di `@prisma/config`, risolta con un `overrides` in
`package.json` che forza `deepmerge-ts@^8.0.1`. L'alternativa suggerita da
`npm audit fix --force` sarebbe stata declassare Prisma alla 6.x: un override
mirato è la soluzione proporzionata.

---

## Cosa devi fare tu

Sequenza completa dal repository clonato al bot funzionante in produzione.

### 1. Cloudflare

```bash
npm install
npx wrangler login          # apre il browser, autorizza l'account
npx wrangler whoami         # conferma account e permessi
```

Se non hai un account: <https://dash.cloudflare.com/sign-up> — il piano Free
basta per tutto quello che serve qui.

### 2. Recupera `DISCORD_PUBLIC_KEY`

```text
https://discord.com/developers/applications
  → la tua applicazione (CLIENT_ID 1538909559081541693)
  → General Information
  → Public Key            ← copia questo valore
```

Sono 64 caratteri esadecimali. **Non è il bot token**: quello sta sotto *Bot*,
ha tre segmenti separati da punto ed è un'altra cosa.

Nella stessa pagina, sotto **Bot → Privileged Gateway Intents**, verifica che
**Server Members Intent** sia attivo: serve anche senza Gateway.

### 3. Carica i secret

```bash
npx wrangler secret put DISCORD_TOKEN
#   incolla il bot token, invio

npx wrangler secret put DISCORD_PUBLIC_KEY
#   incolla la public key del punto 2, invio

npx wrangler secret list    # conferma che entrambi ci siano
```

I secret sono cifrati da Cloudflare e non compaiono mai in un file del
repository.

### 4. Neon + Hyperdrive

Recupera le due connection string da Neon Console → progetto → *Connection
Details*, alternando il toggle *Pooled connection*.

```bash
# Crea il pool Hyperdrive verso Neon.
# Usa l'endpoint DIRETTO (host SENZA "-pooler"): il pooling lo fa Hyperdrive.
npx wrangler hyperdrive create ttp-control-neon \
  --connection-string="postgresql://UTENTE:PASSWORD@ep-xxx.REGION.aws.neon.tech/neondb?sslmode=require"
```

Il comando stampa un `id`. Aprilo `wrangler.jsonc` e sostituisci
`"<hyperdrive-id>"` con quel valore:

```jsonc
"hyperdrive": [
  { "binding": "HYPERDRIVE", "id": "il-tuo-id-qui", ... }
]
```

> Se preferisci saltare Hyperdrive per un primo test, togli del tutto il blocco
> `hyperdrive` da `wrangler.jsonc` e carica invece
> `npx wrangler secret put DATABASE_URL` con l'endpoint **pooled** di Neon.
> Funziona, ma apre una connessione nuova a ogni invocazione: per la
> produzione usa Hyperdrive.

### 5. Applica le migration

Le migration si applicano dalla tua macchina, mai dal Worker.

```bash
cp .env.example .env
#   compila DISCORD_TOKEN, DISCORD_PUBLIC_KEY, DATABASE_URL, DIRECT_URL

npm run prisma:generate
npm run prisma:migrate:deploy
```

Questo crea la sola tabella nuova della V2, `guild_member_snapshots`. Tutte le
tabelle esistenti restano intatte: nessun dato viene toccato.

### 6. Deploy del Worker

```bash
npm run build            # validazione locale del bundle
npm run worker:deploy
```

### 7. Copia l'URL del Worker

Il deploy stampa qualcosa come:

```text
Published ttp-control
  https://ttp-control.<tuo-account>.workers.dev
```

Verifica che sia vivo:

```bash
curl https://ttp-control.<tuo-account>.workers.dev/interactions
#   → TTP Control v1.0.0 — interactions endpoint attivo
```

### 8. Imposta l'Interactions Endpoint URL

```text
Discord Developer Portal
  → la tua applicazione
  → General Information
  → Interactions Endpoint URL
  → https://ttp-control.<tuo-account>.workers.dev/interactions
  → Save Changes
```

Discord invia subito un PING firmato. Se il salvataggio va a buon fine, la
verifica della firma funziona. Se fallisce, torna al punto 3: quasi sempre la
public key è sbagliata o il deploy è precedente al caricamento del secret.

### 9. Registra gli slash command

```bash
npm run commands:deploy
#   → 9 comandi registrati
```

Registrazione per-guild: compaiono immediatamente nel server.

### 10. Verifica in produzione

Nel Discord, in quest'ordine:

```text
/ping                  → Discord API e Database entrambi 🟢
/setup check           → tutti ✅, in particolare:
                           • Guild
                           • Role Hierarchy
                           • Manage Roles / Manage Nicknames
                           • ogni canale
                           • Server Members Intent
/setup verify-panel    → pubblica il pannello di verifica
/setup control-panel   → pubblica il control panel
/panel                 → il control panel effimero risponde
/system sync-check     → report di integrità Discord ↔ database
```

Poi verifica il cron: aspetta 5 minuti e controlla i log.

```bash
npm run worker:tail
#   cerca: "Snapshot iniziale della guild registrato" (prima esecuzione)
#   poi:   "Riconciliazione completata"
```

La **prima** esecuzione del cron è un seed silenzioso: fotografa la guild senza
emettere eventi. È voluto — senza, l'audit riceverebbe un
`MEMBER_JOINED_DISCORD` per ogni membro già presente.

Ultima prova, quella che conta davvero: clicca il bottone **VERIFY** nel
pannello con un account di test, compila il modal, e controlla che compaia
`✅ Verified` — e **non** `🩸 TTP`.

---

## Roadmap

| Fase | Contenuto | Stato |
| --- | --- | --- |
| 0 | Repository e bootstrap del progetto | ✅ |
| 1 | Foundation: env, database, client, loader, logger, `/ping` | ✅ |
| 2 | `/setup` — system check | ✅ |
| 3 | Audit system | ✅ |
| 4 | Verify: pannello, modal, ruolo Verified | ✅ |
| 5 | Candidature TTP e `/member` | ✅ |
| 6 | `/roster` | ✅ |
| 7 | `/community` | ✅ |
| 8 | `/blacklist` | ✅ |
| 9 | `/panel` — control panel | ✅ |
| 10 | Discord events | ✅ |
| 11 | Data consistency e `/system sync-check` | ✅ |
| 12 | **Migrazione a Cloudflare Workers + HTTP Interactions** | ✅ |

Fuori dalla V2: web dashboard, OAuth2, integrazione FiveM, character linking,
stash, heist, voting, statistiche. L'architettura a strati le rende possibili
senza riscritture — la migrazione appena fatta ne è la dimostrazione: sono
cambiati il trasporto e il runtime, non le regole di dominio.

---

## Licenza

Progetto privato — TTP — Impero. Tutti i diritti riservati.
