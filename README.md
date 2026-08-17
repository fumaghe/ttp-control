# TTP Control

Bot Discord gestionale per la gang FiveM GTA RP **TTP — Impero**.

Non è una raccolta di comandi scollegati: è un piccolo gestionale interno con
audit trail, permission matrix applicativa e stato persistito su PostgreSQL.

> **Stato del progetto:** Phase 0 — bootstrap completato.
> La logica Discord (verify, applications, member management, roster,
> community, blacklist, control panel) arriva nelle fasi successive.

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

## Requisiti

| Componente | Versione | Note |
| --- | --- | --- |
| Node.js | **≥ 22.12** (LTS) | richiesto da Prisma 7 (`^20.19 \|\| ^22.12 \|\| >=24`) |
| npm | ≥ 10 | incluso con Node 22 |
| PostgreSQL | 16+ | fornito da Neon |
| Git | qualsiasi recente | |

Stack applicativo:

| Pacchetto | Versione | Ruolo |
| --- | --- | --- |
| `typescript` | 6.0.3 | vedi nota sotto |
| `discord.js` | 14.27.0 | Discord API |
| `prisma` / `@prisma/client` | 7.9.1 | ORM + CLI |
| `@prisma/adapter-pg` | 7.9.1 | driver adapter PostgreSQL |
| `eslint` | 10.8.1 | + `typescript-eslint` 8.67.0 |
| `prettier` | 3.9.6 | formattazione |
| `vitest` | 4.1.10 | test |
| `tsx` | 4.23.12 | esecuzione TS in dev |
| `pino` | 10.3.1 | logging strutturato |

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
cp .env.example .env # poi riempi i valori segreti
```

---

## Configurazione `.env`

`.env.example` contiene **tutti** i placeholder e gli ID Discord non sensibili.
Vanno compilati a mano solo tre valori:

```env
DISCORD_TOKEN=      # Developer Portal → Bot → Reset Token
DATABASE_URL=       # Neon, endpoint POOLED
DIRECT_URL=         # Neon, endpoint DIRECT (unpooled)
```

Tutti gli ID di ruoli e canali sono già presenti in `.env.example`. Il codice
li legge esclusivamente tramite `src/config/env.ts`: **non esistono snowflake
hardcoded nei service**, e i ruoli non vengono mai cercati per nome.

`.env` è in `.gitignore` e non deve mai finire nel repository.

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
  compilata insieme al progetto. È un artefatto di build: è in `.gitignore` ed
  escluso da ESLint.
- `importFileExtension = "js"` fa emettere import ESM `./enums.js`, compatibili
  con `module: nodenext` senza flag aggiuntivi.
- Il client richiede un **driver adapter**. Usiamo `@prisma/adapter-pg` (driver
  `pg` su TCP), la scelta corretta per un processo long-running su VPS;
  `@prisma/adapter-neon` (WebSocket) ha senso solo in contesti serverless/edge.

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
npm run dev            # tsx watch, hot reload
npm run typecheck      # tsc --noEmit su src, tests, scripts, config
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

## Build e produzione

```bash
npm run build   # prisma generate + tsc -> dist/
npm start       # node dist/index.js
```

## Deploy degli slash command

```bash
npm run commands:deploy
```

I comandi vengono registrati sulla singola guild (`GUILD_ID`): la propagazione è
immediata, a differenza dei comandi globali.

---

## Struttura del progetto

```text
ttp-control/
├── prisma/
│   ├── schema.prisma        # modelli + enum di dominio
│   └── migrations/
├── scripts/
│   └── deploy-commands.ts   # registrazione slash command
├── src/
│   ├── index.ts             # entrypoint
│   ├── client/              # costruzione del Discord client
│   ├── commands/            # slash command, per dominio
│   ├── interactions/        # button / modal / select handler
│   ├── events/              # ready, interactionCreate, guildMember*
│   ├── services/            # business logic
│   ├── repositories/        # accesso dati (unico strato che tocca Prisma)
│   ├── components/          # embed, button, modal, select riutilizzabili
│   ├── config/              # env validation, ruoli, canali, permessi
│   ├── database/            # Prisma client + adapter
│   ├── errors/              # errori applicativi tipizzati
│   ├── types/
│   ├── utils/               # logger, helper
│   └── generated/prisma/    # client generato (non versionato)
└── tests/
    ├── unit/
    └── integration/
```

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

## Gateway Intents

Abilitati solo:

- `Guilds`
- `GuildMembers` — **privileged**, va attivato nel Developer Portal
  (Bot → Privileged Gateway Intents → Server Members Intent)

**Non** abilitato `Message Content`: il bot non legge i messaggi degli utenti.

---

## Sicurezza

Checklist prima della produzione:

- [ ] `DISCORD_TOKEN` mai committato
- [ ] password Neon mai committata
- [ ] `.env` ignorato da git
- [ ] nessun secret nei log (il logger redige token e connection string)
- [ ] nessun `Administrator` sul bot
- [ ] ruolo del bot posizionato sopra i ruoli gestiti
- [ ] authorization applicativa attiva su ogni comando **e** su ogni click
- [ ] `customId` di button e modal validati
- [ ] input dei modal validati lato server
- [ ] nessuna fiducia nei valori provenienti dal client
- [ ] accesso al database solo tramite repository
- [ ] audit log funzionante
- [ ] blacklist funzionante e autorevole sul DB
- [ ] `npm audit` verificato
- [ ] backup del database configurato

### Se un secret viene esposto

Un secret comparso in un commit, in un log o in una condivisione va considerato
**compromesso**, anche se il repository è privato. Rimuoverlo dal codice non
basta: resta nella history di git.

- **Discord token** → Developer Portal → Bot → *Reset Token*
- **Password Neon** → Neon Console → *Reset password* del ruolo, poi aggiornare
  `DATABASE_URL` e `DIRECT_URL`

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

## Troubleshooting

**`Environment variable not found: DATABASE_URL`**
`.env` assente o incompleto. `cp .env.example .env` e compilare i valori.

**`prisma migrate` si blocca o fallisce con errori di advisory lock**
Stai migrando attraverso il pooler. Imposta `DIRECT_URL` con l'endpoint senza
`-pooler`.

**`Cannot find module '../generated/prisma/client.js'`**
Il client non è stato generato: `npm run prisma:generate`.

**`Used disallowed intents`**
`Server Members Intent` non è attivo nel Developer Portal → Bot → Privileged
Gateway Intents.

**`Missing Permissions` assegnando un ruolo**
Il ruolo del bot è sotto il ruolo che sta cercando di assegnare. Spostalo sopra
`👑 OG`. `/setup` diagnostica il caso indicando i ruoli non gestibili.

**Gli slash command non compaiono**
Esegui `npm run commands:deploy`. I comandi sono registrati per guild, quindi
`GUILD_ID` deve corrispondere al server.

**Il pannello di verifica si duplica dopo un restart**
I pannelli persistenti sono tracciati nella tabella `PersistentPanel`
(`channelId` + `messageId`). Se il record è stato perso, cancella il messaggio
orfano e ripubblica il pannello.

**`npm audit` segnala `deepmerge-ts` (high)**
Vulnerabilità transitiva di `@prisma/config`, dipendenza **solo di sviluppo**
della CLI Prisma. Non raggiungibile a runtime dal bot e senza fix upstream
disponibile su Prisma 7.9.1. Da rivalutare a ogni aggiornamento di Prisma.

---

## Roadmap

| Fase | Contenuto | Stato |
| --- | --- | --- |
| 0 | Repository e bootstrap del progetto | ✅ |
| 1 | Foundation: env, database, client, loader, logger, `/ping` | ⏳ |
| 2 | `/setup` — system check | ⏳ |
| 3 | Audit system | ⏳ |
| 4 | Verify: pannello, modal, ruolo Verified | ⏳ |
| 5 | Candidature TTP e `/member` | ⏳ |
| 6 | `/roster` | ⏳ |
| 7 | `/community` | ⏳ |
| 8 | `/blacklist` | ⏳ |
| 9 | `/panel` — control panel | ⏳ |
| 10 | Discord events | ⏳ |
| 11 | Data consistency e `/system sync-check` | ⏳ |

Fuori dalla V1: web dashboard, OAuth2, integrazione FiveM, character linking,
stash, heist, voting, statistiche.

---

## Licenza

Progetto privato — TTP — Impero. Tutti i diritti riservati.
