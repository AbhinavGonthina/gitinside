# syntax=docker/dockerfile:1
#
# The analysis worker's production image, run on Cloud Run (docs/SECURITY.md §3, ADR-0074,
# ADR-0111, ADR-0150). Build from the repo root:
#
#   docker build -f apps/worker/Dockerfile -t gitinside-worker .
#
# `build` installs only the worker and the workspace packages it imports, compiles them, and
# `pnpm deploy` copies their built files (each package's `files`) and production
# dependencies to /out/apps/worker. The runtime stage keeps that folder at /app/apps/worker,
# so the analysis child's read root (runner.ts: three levels above dist/) is /app, which
# holds code and nothing else.
#
# Cloud Run applies no read-only root, capability drops, or tmpfs flags, so the hardening
# that must hold there lives in the image itself: a numeric non-root user, nothing on the
# filesystem writable by that user outside /tmp, and no package manager. CI checks it by
# running the image as Cloud Run does (infra/gcp/check.mjs).

# Node 22 LTS: `--permission` (runner.ts) is stable from 22.13. Same major as CI.
ARG NODE_IMAGE=node:22.18.0-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /src
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --filter "@gitinside/worker..."
RUN pnpm --filter "@gitinside/worker..." run build
RUN pnpm --filter @gitinside/worker deploy --prod /out/apps/worker

FROM ${NODE_IMAGE}
# Nothing in the running image can install packages: npm, npx, corepack, and yarn are gone.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
  /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
ENV NODE_ENV=production
# Cloud Run sends requests to the container's own address on PORT (it sets PORT itself).
ENV HOST=0.0.0.0
# Files stay owned by root, so the worker can't change its own code.
COPY --from=build /out /app
# Read-only for the worker except /tmp (in memory on Cloud Run, where job folders go):
# the base image's `node` home and anything else it owns go to root, and every other
# world-writable path (/var/tmp, /run/lock, …) loses that bit.
RUN find / -xdev \( -user 1000 -o -group 1000 \) -exec chown -h root:root {} + \
  && find / -xdev -perm -0002 ! -type l ! -path /tmp -exec chmod o-w {} +
WORKDIR /app/apps/worker
# The base image's unprivileged `node` user, by number so the platform can tell it isn't root.
USER 1000:1000
EXPOSE 8080
CMD ["node", "dist/bin.js"]
