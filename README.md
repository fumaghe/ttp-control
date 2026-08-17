# TTP Control

Bot Discord interno per la gestione del server privato della gang **TTP - Impero** (FiveM GTA RP).

Non è un bot da community generica: è un piccolo **gestionale interno**. Discord è solo
l'interfaccia utente — lo stato reale (membri, gerarchia, verifiche, blacklist, storico,
audit) vive nel database, non nei ruoli Discord.

> **Stato attuale: Phase 0 — Repository & Project Bootstrap.**
> Il progetto contiene per ora solo la toolchain e la struttura. Nessuna logica Discord
> è ancora implementata. Vedi [Roadmap](#roadmap).

---

## Indice

- [Concetti fondamentali](#concetti-fondamentali)
- [Requisiti](#requisiti)
- [Stack tecnologico](#stack-tecnologico)
- [Installazione](#installazione)
- [Configurazione `.env`](#configurazione-env)
- [Database e Prisma](#database-e-prisma)
- [Sviluppo](#sviluppo)
- [Build e produzione](#build-e-produzione)
- [Deploy degli slash command](#deploy-degli-slash-command)
- [Struttura del progetto](#struttura-del-progetto)
- [Architettura](#architettura)
- [Permessi Discord richiesti](#permessi-discord-richiesti)
- [Gateway intents](#gateway-intents)
- [Sicurezza](#sicurezza)
- [Backup del database](#backup-del-database)
- [Troubleshooting](#troubleshooting)
- [Roadmap](#roadmap)

---

## Concetti fondamentali

Questi principi sono vincolanti e non vanno modificati implementando nuove feature.

### Verified ≠ TTP

| Ruolo         | Significato                                  | Accesso                                      |
| ------------- | -------------------------------------------- | -------------------------------------------- |
| `✅ Verified` | Persona autorizzata a frequentare il Discord | `STREET`, `CHILL ZONE`                       |
| `🩸 TTP`      | Membro effettivo della gang                  | `THE HOUSE`, `GANG INFO`, `STASH` + le sopra |

L'approvazione di una verifica assegna **solo** `✅ Verified`. Non assegna mai `🩸 TTP`.
Diventare membro è un'operazione separata e deliberata (`/member add`).

### Struttura del server

```
ENTRANCE      →  chiunque entri (welcome, rules, verify, announcements)
STREET+CHILL  →  Verified: esterni, amici, mafie
HOUSE+GANG INFO+STASH  →  area privata TTP
LEADER        →  leadership (💎 Big, 👑 OG)
```

Il bot **non crea e non rinomina** categorie o canali: gestisce gli accessi tramite ruoli.

### Dimensioni indipendenti dei ruoli

Un membro può avere contemporaneamente ruoli di dimensioni diverse, che non vanno mescolate:

- **membership** — `✅ Verified`, `🩸 TTP`
- **rank** — `🏠 Resident` → `🥷 Gangster` → `🩸 Young OG` → `💎 Big` → `👑 OG`
- **status** — `💤 Inactive`, `☠️ Permadeath`, `🚫 Banned`
- **badge** — `🎖️ Honor 1`, `🏅 Honor 2`, `🎁 Supporter`, `🕰️ First Day`
- **specializzazione** — `🎯 Shooter`, `👑 Main Shooter`
- **relazione** — `🤝 Friend`, `🎩 Mafia`

### Gli ID sono la chiave, mai i nomi

Ruoli, canali e utenti sono sempre identificati per **Discord ID**. Nomi e username
cambiano; gli ID no. Nessun ID reale è mai committato: stanno tutti nel `.env`.

---

## Requisiti

| Software    | Versione                              | Note                               |
| ----------- | ------------------------------------- | ---------------------------------- |
| **Node.js** | `>= 22.12` (LTS) — testato su `22.22` | Richiesto da Prisma 7 ed ESLint 10 |
| **npm**     | `>= 10`                               | Incluso in Node                    |
| **Git**     | qualsiasi versione recente            |                                    |

Verifica:

```bash
node -v   # deve essere >= v22.12
npm -v
```

---

## Stack tecnologico

| Libreria                         | Versione       | Perché                                                           |
| -------------------------------- | -------------- | ---------------------------------------------------------------- |
| `typescript`                     | `6.0.x`        | Ultima stabile compatibile con `typescript-eslint@8` (vedi nota) |
| `discord.js`                     | `14.x`         | Client Discord                                                   |
| `prisma` / `@prisma/client`      | `7.x`          | ORM + migrazioni                                                 |
| `@prisma/adapter-better-sqlite3` | `7.x`          | Driver adapter SQLite (default in Prisma 7)                      |
| `zod`                            | `4.x`          | Validazione env e input dei modal                                |
| `dotenv`                         | `17.x`         | Caricamento `.env`                                               |
| `tsx`                            | `4.x`          | Esecuzione TypeScript in development                             |
| `eslint` + `typescript-eslint`   | `10.x` / `8.x` | Linting type-aware                                               |
| `prettier`                       | `3.x`          | Formattazione                                                    |
| `vitest`                         | `4.x`          | Test della business logic                                        |

> **Nota su TypeScript 6 vs 7.**
> TypeScript `7.0.x` (il nuovo compiler nativo) è già pubblicato, ma `typescript-eslint@8`
> dichiara peer `typescript >=4.8.4 <6.1.0`: con TS 7 il linting type-aware si romperebbe.
> Restiamo su TS `6.0.x` finché `typescript-eslint` non supporta ufficialmente TS 7.

---

## Installazione

```bash
git clone <repo-url> ttp-control
cd ttp-control
npm install
cp .env.example .env
```

Poi compila `.env` (vedi sotto) e inizializza il database.

---

## Configurazione `.env`

`.env.example` è il template autorevole e contiene **solo placeholder**. Copialo in `.env`
e riempilo.

Per ottenere gli ID: in Discord attiva **Impostazioni → Avanzate → Modalità sviluppatore**,
poi click destro su ruolo/canale/utente → _Copia ID_.

Gruppi di variabili:

| Gruppo      | Variabili                                                           |
| ----------- | ------------------------------------------------------------------- |
| Runtime     | `NODE_ENV`, `LOG_LEVEL`                                             |
| Discord app | `DISCORD_TOKEN`, `CLIENT_ID`, `GUILD_ID`, `OWNER_ID`                |
| Database    | `DATABASE_URL`                                                      |
| Ruoli       | `ROLE_*_ID` (membership, gerarchia, community, status, badge, spec) |
| Canali      | `CHANNEL_*_ID`                                                      |

L'avvio del bot valida l'intero `.env` con Zod (da Phase 1): se manca una variabile
obbligatoria o un ID non ha forma di snowflake, il processo si ferma subito con un
messaggio esplicito, invece di fallire a metà di un'operazione.

---

## Database e Prisma

Si parte con **SQLite**. Lo schema e la business logic sono scritti in modo da poter
migrare a **PostgreSQL** cambiando solo `datasource` e `DATABASE_URL` — le repository
isolano Prisma dal resto del codice.

```bash
npm run prisma:generate   # genera il client tipizzato
npm run prisma:migrate    # crea/applica le migrazioni in development
npm run prisma:studio     # GUI per ispezionare il DB
npm run prisma:deploy     # applica le migrazioni in produzione (no prompt)
```

Il file `.db` vive in `data/` ed è **ignorato da Git**.

---

## Sviluppo

```bash
npm run dev            # avvia il bot in watch mode (tsx)
npm run typecheck      # tsc --noEmit
npm run lint           # eslint
npm run lint:fix       # eslint --fix
npm run format         # prettier --write
npm run format:check   # prettier --check
npm test               # vitest run
npm run test:watch     # vitest in watch
npm run check          # typecheck + lint + format:check + test
```

Esegui `npm run check` prima di ogni commit.

---

## Build e produzione

```bash
npm run build   # compila in dist/ (tsconfig.build.json)
npm start       # node dist/src/index.js
```

`tsconfig.build.json` esclude test e file di configurazione, e usa `rootDir: "."`,
quindi l'entry point compilato è `dist/src/index.js`.

---

## Deploy degli slash command

```bash
npm run commands:deploy
```

Registra i comandi sulla guild indicata da `GUILD_ID` (registrazione guild-scoped:
propagazione istantanea, a differenza di quella globale che può richiedere fino a un'ora).

I comandi vanno rideployati ogni volta che cambiano nome, descrizione o opzioni — non
a ogni riavvio del bot.

---

## Struttura del progetto

```
ttp-control/
├── src/
│   ├── index.ts              # entry point: bootstrap e shutdown
│   ├── client/               # creazione e configurazione del client Discord
│   ├── commands/             # definizioni slash command
│   │   ├── setup/  member/  roster/  community/  blacklist/  panel/
│   ├── interactions/         # handler di button, modal, select menu
│   │   ├── verify/  members/  community/  blacklist/  panels/
│   ├── events/               # handler degli eventi gateway
│   ├── services/             # BUSINESS LOGIC (nessuna dipendenza da discord.js dove evitabile)
│   ├── repositories/         # unico punto di accesso a Prisma
│   ├── components/           # embed, button, modal, select menu riutilizzabili
│   │   ├── embeds/  buttons/  modals/  selectMenus/
│   ├── config/               # env, roles, channels, permissions
│   ├── types/                # tipi condivisi
│   └── utils/                # logger, errori, helper
├── prisma/
│   ├── schema.prisma
│   └── migrations/
├── scripts/
│   └── deploy-commands.ts
├── tests/unit/               # test della business logic
├── data/                     # database SQLite (git-ignored)
├── backups/                  # dump periodici (git-ignored)
├── .env.example
├── eslint.config.js
├── prettier.config.js
├── tsconfig.json
├── tsconfig.build.json
└── vitest.config.ts
```

---

## Architettura

Il flusso è a senso unico. La business logic non vive mai dentro gli handler Discord,
così slash command e button possono condividere lo stesso servizio senza duplicazioni.

```
Discord Interaction
        ↓
Interaction Handler      (parsing, ack entro 3s, risposta)
        ↓
Authorization            (permission matrix applicativa, non solo Discord perms)
        ↓
Service                  (business rules, transizioni di stato)
       ↙ ↘
Discord    Repository
              ↓
            Prisma
              ↓
            SQLite
```

Ogni operazione amministrativa segue sempre la stessa sequenza:

```
VALIDATE → AUTHORIZE → CHECK CURRENT STATE → EXECUTE → PERSIST → AUDIT → RESPOND
```

Un fallimento nell'invio del log Discord non deve far fallire l'operazione principale,
ma va registrato.

---

## Permessi Discord richiesti

Il bot **non** deve avere `Administrator`. I permessi necessari sono:

| Permesso               | Serve per                                     |
| ---------------------- | --------------------------------------------- |
| `View Channels`        | Leggere la struttura del server               |
| `Send Messages`        | Pannelli e log                                |
| `Embed Links`          | Embed                                         |
| `Read Message History` | Ritrovare e aggiornare i pannelli persistenti |
| `Manage Roles`         | Assegnare/rimuovere ruoli gestiti             |
| `Manage Nicknames`     | Allineare il nickname al nome IC (opzionale)  |

**Posizione del ruolo del bot:** Discord permette di gestire solo i ruoli _sotto_ il
proprio ruolo più alto. Il ruolo `TTP Control` deve stare **sopra** ogni ruolo che il bot
deve assegnare — incluso `👑 OG` — e sotto nient'altro di rilevante. `/setup` (Phase 2)
verifica questa condizione e segnala esattamente quali ruoli sono fuori portata.

---

## Gateway intents

Solo il minimo indispensabile:

| Intent         | Tipo         | Perché                                            |
| -------------- | ------------ | ------------------------------------------------- |
| `Guilds`       | standard     | Cache di guild, canali e ruoli                    |
| `GuildMembers` | privilegiato | `guildMemberAdd/Remove/Update`, lettura dei ruoli |

`GuildMembers` va abilitato nel Developer Portal → _Bot_ → _Privileged Gateway Intents_.

`MessageContent` **non** è abilitato: il bot non legge i messaggi degli utenti.

---

## Sicurezza

- `.env` è in `.gitignore` e non deve **mai** entrare nel repository.
- Token, password e secret non vengono mai scritti nel codice né nei log.
- Se un token viene esposto (incollato in chat, committato, stampato in un log) va
  considerato **compromesso**: rigeneralo dal Developer Portal.
- L'autorizzazione è applicativa, non solo Discord: `Big` non può amministrare `OG`.
- Ogni `customId` di button/modal viene validato lato server; nessun valore ricevuto dal
  client è considerato affidabile.
- Le risposte amministrative sono ephemeral: note e dati sensibili non finiscono in Street.

### Avviso `npm audit` noto

`npm audit` segnala 3 vulnerabilità _high_ che risalgono tutte a `deepmerge-ts@7.1.5`,
pinnato esattamente da `@prisma/config`, dipendenza della **CLI Prisma**.

- La CLI Prisma è una `devDependency`: non finisce nel runtime di produzione.
- `@prisma/client`, l'unico pacchetto Prisma usato a runtime, non è coinvolto.
- L'unico `fix` proposto da npm è il downgrade a `prisma@6.12.0`, un major indietro.

Rimaniamo su Prisma 7 e teniamo l'avviso monitorato: va risolto quando `@prisma/config`
aggiornerà il pin. Non aggiungere `overrides` senza aver verificato che la CLI funzioni.

---

## Backup del database

```
data/
    ttp-control.db
backups/
    ttp-control-YYYY-MM-DD-HHMM.db
```

Entrambe le directory sono git-ignored. La rotazione dei backup (numero massimo di copie
conservate) sarà configurabile. Lo script di backup arriva in Phase 14.

---

## Troubleshooting

| Sintomo                                   | Causa probabile                                                |
| ----------------------------------------- | -------------------------------------------------------------- |
| `Used disallowed intents`                 | `GuildMembers` non abilitato nel Developer Portal              |
| `Missing Permissions` assegnando un ruolo | Ruolo del bot troppo in basso nella gerarchia — spostalo sopra |
| Gli slash command non compaiono           | Manca `npm run commands:deploy`, oppure `GUILD_ID` errato      |
| `Unknown interaction`                     | Nessun ack entro 3 secondi — serve `deferReply()`              |
| `Interaction has already been replied to` | Doppia risposta alla stessa interaction                        |
| `Environment validation failed` all'avvio | Variabile mancante o ID non valido in `.env`                   |
| Errori Prisma su `.db` mancante           | Manca `npm run prisma:migrate`                                 |
| `Cannot find package '@eslint/js'`        | `npm install` non completato                                   |

---

## Roadmap

| Fase | Contenuto                                        | Stato       |
| ---- | ------------------------------------------------ | ----------- |
| 0    | Repository & project bootstrap                   | ✅ fatto    |
| 1    | Foundation: env, logger, Prisma, client, `/ping` | ⏳ prossima |
| 2    | `/setup` — system check                          | ⬜          |
| 3    | Audit system                                     | ⬜          |
| 4    | Verify panel, modal, approve/reject              | ⬜          |
| 5    | `/member` — member management                    | ⬜          |
| 6    | `/roster`                                        | ⬜          |
| 7    | `/community`                                     | ⬜          |
| 8    | `/blacklist` + rejoin detection                  | ⬜          |
| 9    | `/panel` — control panel                         | ⬜          |
| 10   | Eventi Discord                                   | ⬜          |
| 11   | Data consistency checks                          | ⬜          |
| 12   | Error handling completo                          | ⬜          |
| 13   | Security review                                  | ⬜          |
| 14   | Deployment + backup                              | ⬜          |

Fuori scope per la v1: web dashboard, OAuth2, PostgreSQL, integrazione FiveM,
character linking, stash/heist management, voting, statistiche.
