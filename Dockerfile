# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS base

ENV NPM_CONFIG_FUND=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*

FROM base AS build

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

COPY . .

RUN npm run db:generate \
    && npm run build

FROM build AS production-deps

RUN npm prune --omit=dev

FROM base AS runner

ENV NODE_ENV=production \
    PORT=3001

RUN groupadd --system --gid 1001 servicehub \
    && useradd --system --uid 1001 --gid servicehub --create-home servicehub

COPY --from=production-deps --chown=servicehub:servicehub /app/package.json /app/package-lock.json ./
COPY --from=production-deps --chown=servicehub:servicehub /app/node_modules ./node_modules
COPY --from=build --chown=servicehub:servicehub /app/dist ./dist
COPY --from=build --chown=servicehub:servicehub /app/prisma ./prisma

USER servicehub

EXPOSE 3001

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3001/health').then((response) => { if (!response.ok) process.exit(1) }).catch(() => process.exit(1))"]

CMD ["node", "./dist/src/server.js"]
