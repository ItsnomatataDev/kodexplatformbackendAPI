# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    APP_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 kode \
    && useradd --system --uid 10001 --gid kode --home-dir /app --shell /usr/sbin/nologin kode

COPY --from=deps --chown=kode:kode /app/node_modules ./node_modules
COPY --from=build --chown=kode:kode /app/dist ./dist
COPY --chown=kode:kode package.json ./
COPY --chown=kode:kode migrations ./migrations

USER kode
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health/live').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]

FROM runtime AS media-worker
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
USER kode
HEALTHCHECK NONE
CMD ["node", "dist/content/playback-worker.js"]

# Separate from the legacy Content Studio worker; opt-in deployment only.
FROM media-worker AS media-platform-worker
USER root
RUN mkdir -p /scratch && chown 10001:10001 /scratch
USER kode
ENV TMPDIR=/scratch
CMD ["node", "dist/media-platform/processing-worker.js"]

FROM runtime AS media-auth
ENV MEDIA_AUTH_PORT=3200
EXPOSE 3200
HEALTHCHECK NONE
CMD ["node", "dist/media-platform/playback/auth-server.js"]

# Opt-in independent authentication runtime; ordinary API remains the default final target.
FROM runtime AS infrastructure
ENV INFRA_ENABLED=false INFRA_PORT=3101 INFRA_HOST=0.0.0.0
EXPOSE 3101
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3101/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/infrastructure/server.js"]

FROM runtime AS content-studio-upload-maintenance
HEALTHCHECK NONE
ENV CONTENT_STUDIO_UPLOAD_MAINTENANCE_INTERVAL_SECONDS=300
CMD ["node", "dist/content/resumable/run-maintenance.js"]

FROM runtime AS api
