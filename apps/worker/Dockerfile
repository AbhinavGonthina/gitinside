# syntax=docker/dockerfile:1
#
# The analysis worker's production image (docs/SECURITY.md §3, ADR-0074).
# Build from the repo root, normally through the production stack:
#
#   docker compose -f infra/oracle/compose.yml build
#
# `build` installs only the worker and the workspace packages it imports, compiles them, and
# `pnpm deploy` copies their built files (each package's `files`) and production
# dependencies to /out/apps/worker. The runtime stage keeps that folder at /app/apps/worker,
# so the analysis child's read root (runner.ts: three levels above dist/) is /app, which
# holds code and nothing else. Hardening that belongs to the container (read-only root,
# tmpfs, capabilities, limits) is set in infra/oracle/compose.yml.

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
# Files stay owned by root, so the worker can't change its own code even with a writable root.
COPY --from=build /out /app
WORKDIR /app/apps/worker
# The image's unprivileged `node` user (uid 1000); compose mounts /tmp/jobs for it.
USER node
EXPOSE 8080
CMD ["node", "dist/bin.js"]
