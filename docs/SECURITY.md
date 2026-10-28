# Security

GitInside analyzes **untrusted code** submitted by anyone, and holds **private repo data** for signed-in users. Decisions: ADR-0007, ADR-0009, ADR-0014, ADR-0015; D5.8, D7.1–D7.3.

## 1. Assets

- **Private repo contents and their graphs** (installation-scoped).
- **Secrets:**
  - GitHub App private key and webhook secret.
  - OAuth client secret.
  - Neon connection string, R2 keys.
  - Enqueue HMAC secret, session secret.
- **Users' GitHub identities and sessions.**
- **Availability** of the worker VM and the free-tier quotas.

## 2. Threat model

| # | Threat | Vector | Mitigation |
|---|---|---|---|
| T1 | Code execution from an analyzed repo | `postinstall` scripts, config files that execute (`next.config.js`, `vite.config.ts`), `.npmrc` hooks | We never run `npm`/`pnpm`, scripts, or `require`/`import` repo files. The analyzer only reads text via the TS compiler API. The analysis child runs under Node's permission model (`apps/worker/src/runner.ts`, ADR-0059): it can't start processes or worker threads, load addons, read outside the app and the job's `src`, or write anything but its output file, and its environment is empty. Test: the postinstall fixture's sentinel file never appears; no unexpected child processes. |
| T2 | Filesystem escape during extraction | `../` paths, absolute paths, symlinks, hard links in the tarball | A streaming tar extractor we parse ourselves (`apps/worker/src/extract.ts`, ADR-0058) writes only regular files and directories (links and special files are skipped and listed, so nothing can redirect a later write), fails the job on any absolute or `..` path, and checks every resolved path stays inside the job dir. Files are created exclusively (no overwrite). Tests for each. |
| T3 | Resource exhaustion | zip bombs, huge files, millions of files, deep nesting, pathological TS (huge unions, recursion) | Limits: 500 MB extracted (counted on the decompressed stream, so a gzip bomb stops early), 100,000 archive entries, 2 MB per file (skipped by the analyzer), 20k source files, depth 64, child process with `--max-old-space-size` (3 GB, `LIMIT_MEMORY`), CPU/time limit (5 min wall clock, killed with SIGKILL, `LIMIT_TIME`; CPU share capped by the container), at most 2 concurrent jobs. |
| T4 | Network abuse from the worker | an analyzer bug or a future plugin making requests | Container egress allowlist: `api.github.com`, `codeload.github.com`, R2 endpoint, Neon host. The analysis child process itself has no network need; the worker fetches the tarball before forking (`apps/worker/src/github.ts`, ADR-0061: redirects followed by hand, only within the API or to `codeload.github.com`, and the GitHub token is never sent past the API host), and a preloaded guard (`netguard.ts`) fails every socket, DNS, and `fetch` call in the child with `ERR_NETWORK_DISABLED` (defense in depth; the egress allowlist is the boundary). |
| T5 | Secret leakage into graphs | `.env` values, hardcoded keys | The env detector reads key **names** and URL **schemes/hosts** only; values are discarded at parse time. Graph strings are never built from env values. Credentials are dropped from literal URL hosts, and source text shown on unresolved requests has string contents masked outside the URL path (ADR-0038). Test: `fake-secrets` fixture output contains none of its planted values. |
| T6 | Private data exposure | a public cache key collision, missing access checks, shared links | Private snapshots live under `private/<installationId>/…` and are never served via CDN. Every private view checks access (cache ≤ 60s). Private pages are `noindex`, and badges for private repos are link-only. Tests: user without access → 404 (not 403, to avoid confirming existence); revoked access → denied within 60s. |
| T7 | Stale data after uninstall | data retained after the user leaves | The `installation.deleted` / `installation_repositories.removed` webhook deletes snapshots, analyses, PR records, and access cache for those repos immediately. Tested. |
| T8 | Forged webhooks or enqueue calls | attacker POSTs to `/api/github/webhook` or the VM enqueue API | GitHub HMAC (`X-Hub-Signature-256`) verified with constant-time comparison. Enqueue API (`apps/worker/src/api.ts`, ADR-0060) requires an HMAC-SHA256 over timestamp + method + path + raw body (±5 min) with a shared secret (current or, during a rollover, previous), checked before parsing or routing, and listens behind TLS. Bodies over 16 KiB are refused unread; job IDs are derived from the request, so a replay inside the window is a no-op. Redis is bound to the Docker network only. |
| T9 | Abuse / denial of wallet | spamming analyses to exhaust quotas | Per-IP and per-user rate limits (D8.4), dedupe by `repo@sha`, global concurrency 2, retention eviction, quota alarms at 80% (needs-abhinav issue). Nothing can incur charges (D8.2). |
| T10 | XSS from repo content | file names, labels, code previews rendered in the UI | React escaping everywhere; Shiki output is sanitized; no `dangerouslySetInnerHTML` with repo strings; strict CSP on `apps/web`. Mermaid export escapes labels. |
| T11 | Overbroad GitHub permissions | App asking for more than needed | Permissions: Contents read, Metadata read, Pull requests read & write (comment), Checks read & write. No admin, no workflows, no write to contents. OAuth sign-in requests identity only. |
| T12 | Supply chain (our own dependencies) | malicious npm package in GitInside | Pinned versions, lockfile committed, `pnpm install --frozen-lockfile` in CI, minimal dependencies, Dependabot alerts on. |
| T13 | Autopilot loosening its own limits | an unattended run edits the loop script or permission settings | `.claude/settings.json` denies edits to `scripts/autopilot.*` and `.claude/settings*.json`. The loop denies force push, `gh repo delete/edit`. `main` is branch-protected (no force push or deletion). |

## 3. Worker container

- Runs as a non-root user, with a read-only root filesystem. The only writable path is `/tmp/jobs` (tmpfs, size-capped).
- `no-new-privileges`, all Linux capabilities dropped, a seccomp default profile.
- Each job (`apps/worker/src/job.ts`): tarball → `/tmp/jobs/<jobId>-<random>/src` → child process with resource limits → `architecture.json` → upload → the job dir is deleted (also deleted on failure). The worker sweeps `/tmp/jobs` at startup for folders a killed process left behind.
- Redis runs in a sibling container on an internal Docker network with no published port. The enqueue API is the only exposed port, behind Caddy TLS on the VM.
- The VM firewall allows inbound 443 (and 22 from Abhinav's IP for SSH). Everything else is denied.

## 4. Secrets handling

- Never committed. `.env*` is gitignored. Example files (`.env.example`) contain names only.
- **Production:** Vercel environment variables (web) and a root-only `/etc/gitinside/worker.env` on the VM (worker).
- Abhinav enters secrets himself. Autopilot never asks for secret values in issues, logs, or commits, and never prints them.
- Rotation: GitHub App keys and HMAC secrets can be rotated without downtime (two valid secrets during rollover).

## 5. Reporting

`SECURITY.md` at the repo root (added in M9) gives a contact for vulnerability reports. Until then, issues go to Abhinav directly.
