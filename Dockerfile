# One Dockerfile, two runtime targets: `web` (Next.js standalone) and `worker`.
# Both are built from the same sources in the `build` stage.

FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:24-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-slim AS base
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
# Shared volume for uploaded Datasets (ADR 0003).
ENV UPLOADS_DIR=/data/uploads
RUN mkdir -p /data/uploads && chown node:node /data/uploads

FROM base AS web
ENV HOSTNAME=0.0.0.0 PORT=3000
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
USER node
EXPOSE 3000
CMD ["node", "server.js"]

FROM base AS worker
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json ./
COPY --from=build /app/dist ./dist
USER node
CMD ["node", "--enable-source-maps", "dist/worker.mjs"]
