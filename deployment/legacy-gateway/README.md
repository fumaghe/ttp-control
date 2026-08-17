# Deployment legacy — Discord Gateway su Docker/VPS

Questa cartella conserva la configurazione Docker della **V1**, quando TTP
Control girava come processo Node persistente collegato al Gateway Discord.

> **Il deployment primario è Cloudflare Workers.** Vedi il README nella root.
> Quello che trovi qui è una via di ritorno, non un'alternativa mantenuta.

---

## Perché la configurazione è qui e il codice no

La versione Gateway richiedeva:

- `discord.js` completo (WebSocket, cache della guild, `ws`, `zlib`);
- `pino` + `pino-pretty` (stream Node, `worker_threads`);
- i listener `ready`, `interactionCreate`, `guildMemberAdd`,
  `guildMemberRemove`, `guildMemberUpdate`;
- un processo che resta acceso, con la sua VPS.

Niente di tutto questo funziona — o serve — sulla runtime dei Worker.
Mantenere entrambi i runtime nello stesso albero avrebbe significato due
adapter Discord da tenere allineati e un bundle che si porta dietro
dipendenze Node inutilizzabili: esattamente il problema che la migrazione
doveva risolvere.

I file di runtime del Gateway sono quindi **rimossi dal branch corrente ma
intatti nella storia git**, recuperabili con un comando esatto (sotto).

---

## Tornare alla versione Gateway

La V1 completa vive sul commit di `main` che l'ha introdotta:

```bash
# 1. Trova il commit della V1
git log --oneline main | grep "complete TTP Control v1"
#   6950262 feat: complete TTP Control v1

# 2. Ripristina il runtime Gateway su un branch dedicato
git checkout -b rollback/gateway 6950262

# 3. Da qui il progetto è quello della V1: Dockerfile in root, npm start, ecc.
docker compose up -d --build
```

Se invece vuoi solo i singoli file del runtime Gateway dentro il branch
corrente:

```bash
git checkout 6950262 -- \
  src/index.ts \
  src/client/createClient.ts \
  src/client/createContext.ts \
  src/client/discordRoleGateway.ts \
  src/client/discordAuditSink.ts \
  src/events/

npm install discord.js@14.27.0 pino@10.3.1 pino-pretty@13.1.3 dotenv@17.4.2
```

Nota: i file recuperati usano l'`AppContext` della V1 (con `client` e `guild`
di discord.js) e vanno riadattati se li mescoli con il codice attuale. Il
percorso pulito è il branch di rollback.

---

## Usare i file di questa cartella

Il `Dockerfile` e il `docker-compose.yml` presuppongono di stare nella root
del progetto, come nella V1. Per usarli:

```bash
cp deployment/legacy-gateway/Dockerfile .
cp deployment/legacy-gateway/docker-compose.yml .
cp deployment/legacy-gateway/.dockerignore .

docker compose up -d --build
docker compose logs -f
```

Richiedono un `.env` completo, con in più le variabili che la versione
Cloudflare non usa (`NODE_ENV`, `LOG_LEVEL`, `DATABASE_URL` diretta verso
Neon senza Hyperdrive). `DISCORD_PUBLIC_KEY` **non** serve al Gateway: la
firma delle interaction esiste solo sul trasporto HTTP.

---

## Differenze operative fra i due deployment

| | Gateway (legacy) | Workers (attuale) |
| --- | --- | --- |
| Runtime | Node 22 su VPS/Docker | Cloudflare Workers |
| Interaction | evento `interactionCreate` | webhook HTTP firmato |
| Eventi membri | `guildMemberAdd/Remove/Update` | Cron Trigger + snapshot |
| Costo | VPS | piano gratuito |
| Presenza online | il bot risulta *Online* | nessuna presenza |
| Stato in memoria | cache guild persistente | nessuno, tutto a database |

L'ultima riga è l'unica differenza percepibile dagli utenti: senza Gateway il
bot non compare "Online" nella lista membri. I comandi funzionano
identicamente.
