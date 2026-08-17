# =============================================================================
# TTP Control — immagine di produzione
# =============================================================================
# Build multi-stage: l'immagine finale contiene solo le dipendenze di runtime
# e il codice compilato. Nessun secret viene mai copiato dentro: token e
# connection string arrivano dall'ambiente all'avvio del container.
# =============================================================================

# --- Stage 1: build -----------------------------------------------------------
FROM node:22-bookworm-slim AS build

WORKDIR /app

# I manifest prima del codice: se non cambiano, il layer di install resta
# in cache anche quando cambia il sorgente.
COPY package.json package-lock.json ./

# `--ignore-scripts` disattiva il `postinstall` (prisma generate): lo schema
# non è ancora stato copiato, quindi fallirebbe. Lo eseguiamo dopo.
RUN npm ci --ignore-scripts

COPY prisma ./prisma
COPY prisma.config.ts tsconfig.json ./
COPY src ./src

# `prisma generate` non richiede un database raggiungibile.
RUN npx prisma generate && npx tsc -p tsconfig.json

# --- Stage 2: dipendenze di produzione ----------------------------------------
FROM node:22-bookworm-slim AS deps

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# --- Stage 3: runtime ----------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
# `dumb-init` come PID 1: inoltra SIGTERM al processo Node, che è la
# condizione perché il graceful shutdown venga davvero eseguito.
RUN apt-get update \
    && apt-get install -y --no-install-recommends dumb-init \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# L'immagine node fornisce già un utente `node` non privilegiato.
COPY --chown=node:node --from=deps /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node package.json ./
# Lo schema serve a runtime per `prisma migrate deploy` in fase di rilascio.
COPY --chown=node:node --from=build /app/prisma ./prisma

USER node

# Health check: il processo è vivo e ha un event loop reattivo.
# Il bot non espone una porta HTTP, quindi la sonda è a livello di processo.
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
    CMD node -e "process.exit(0)"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]
