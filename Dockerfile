FROM node:24-bookworm-slim AS build

WORKDIR /app
COPY vendor ./vendor
COPY package.json package-lock.json ./
# Avoid dependency lifecycle scripts that invoke package managers at build time;
# explicitly build the only required native addon afterwards.
RUN npm ci --ignore-scripts \
    && npm rebuild node-datachannel

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=8000 \
    HOST=0.0.0.0 \
    CACHE_DIR=/tmp/torrent-window-gateway

WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./package.json
COPY --chown=node:node docs ./docs
COPY --chown=node:node vendor ./vendor

USER node
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8000)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "dist/server.js"]
