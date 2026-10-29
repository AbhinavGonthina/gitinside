# The worker VM (Oracle Cloud Always Free)

The analysis worker, its Redis, the egress gateway, and Caddy run as one Docker Compose stack on an Ubuntu 24.04 VM (A1.Flex, 4 OCPU / 24 GB, ARM). Everything on the VM comes from this folder, so a reclaimed or broken VM is rebuilt by running one script again. Security background: [docs/SECURITY.md](../../docs/SECURITY.md) §3; decisions: ADR-0074 (image and stack), ADR-0075 (egress, Caddy, provisioning).

| File | What it is |
|---|---|
| `compose.yml` | The stack: `egress`, `worker`, `redis`, `caddy` |
| `egress/` | The gateway image: dnsmasq plus the iptables rules the worker's traffic goes through |
| `Caddyfile` | TLS on 443 for `worker.gitinside.abhinavgonthina.dev`, the API's three routes only |
| `provision.sh` | Installs Docker, loads kernel modules, checks out the repo, migrates, installs the systemd unit |
| `check.mjs`, `compose.check.yml` | CI's check of the whole stack (job `worker-image`); never deployed |

## What runs

```
internet ──443──▶ caddy ──egress:8080──▶ [ egress gateway netns: worker API + analysis children ]
                                                 │ DNS: dnsmasq, allowlisted names only
                                                 │ TCP out: allowlisted addresses, 443/5432
                                                 ▼
                       api.github.com, codeload.github.com, <account>.r2.cloudflarestorage.com, Neon
                                                 │
                                    internal network (no route out) ── redis
```

- **caddy** publishes 443, gets its certificate from Let's Encrypt (TLS-ALPN challenge; port 80 stays closed), and forwards `GET /health`, `POST /enqueue`, and `GET /jobs/:id` unchanged. Anything else gets a 404 from Caddy.
- **egress** owns the network namespace the worker runs in. Its dnsmasq resolves only `api.github.com`, `codeload.github.com`, `<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`, the hosts of `DATABASE_URL` / `DATABASE_URL_UNPOOLED` (read from the env file), and the stack's own service names. Everything else is NXDOMAIN. TCP may leave only to addresses dnsmasq handed out, on 443 or 5432. Raw IPs, other ports, the cloud metadata address, outside DNS servers, Docker's own resolver, and IPv6 are refused.
- **worker** has no network of its own (`network_mode: service:egress`) and no capabilities, so it can't change those rules. It is also on `127.0.0.1:8080` for checks from the VM itself.
- **redis** is on an internal network with no route out and no published port.

What the allowlist doesn't stop: R2 and Neon sit behind shared addresses (Cloudflare's and AWS's), so a process holding one of those addresses could reach another tenant behind the same address by sending a different TLS server name. Nothing in the worker runs repo code (SECURITY.md T1), and the analysis child has no network at all (`netguard.ts`), so this is a second wall, not the first.

## First setup

Prerequisites: planning issue #3 (VM, security list with ingress 443 from anywhere and 22 from your IP) and #7 (DNS A record `worker.gitinside` → the VM's public IP, DNS-only if the zone is on Cloudflare).

1. SSH in: `ssh ubuntu@<public IP>`.
2. Get the script and run it:
   ```sh
   sudo apt-get update && sudo apt-get install -y git
   sudo git clone https://github.com/AbhinavGonthina/gitinside.git /opt/gitinside
   sudo /opt/gitinside/infra/oracle/provision.sh
   ```
   The first run stops after creating `/etc/gitinside/worker.env` (root-only, mode 0600).
3. Fill in the values: `sudo nano /etc/gitinside/worker.env`. The names and where each value comes from are in `apps/worker/.env.example` and ADR-0055: `DATABASE_URL` (Neon pooled), optionally `DATABASE_URL_UNPOOLED` (Neon direct, used for migrations), `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `ENQUEUE_HMAC_SECRET` (the same value as in Vercel), and optionally `GITHUB_TOKEN`. `REDIS_URL` in the example is ignored (the stack sets it).
4. Run the script again: `sudo /opt/gitinside/infra/oracle/provision.sh`. It builds the images on the VM (the first ARM build takes several minutes), applies the migrations, and starts the stack through the `gitinside` systemd unit.
5. Check from your own machine: `curl https://worker.gitinside.abhinavgonthina.dev/health` should print `{"status":"ok"}`. The first request can take a few seconds while Caddy gets its certificate.

## Updating

```sh
sudo /opt/gitinside/infra/oracle/provision.sh               # latest main
sudo /opt/gitinside/infra/oracle/provision.sh --ref m5      # a tag or commit
```

The unit restarts the stack, which cancels running jobs. BullMQ retries them, and Redis keeps the queue in its volume.

## Rebuilding a lost VM

Create a new VM as in #3, point the DNS record at its IP (#7), and follow **First setup**. Only the env file has to be entered again. Jobs that were queued on the old VM are lost. The web app answers "temporarily unavailable" meanwhile, and visitors can retry (DESIGN.md §12).

## Operations

| Task | Command |
|---|---|
| Status | `sudo docker compose -f /opt/gitinside/infra/oracle/compose.yml ps` |
| Logs (JSON lines) | `sudo docker compose -f /opt/gitinside/infra/oracle/compose.yml logs -f worker` |
| Restart | `sudo systemctl restart gitinside` |
| Stop | `sudo systemctl stop gitinside` |
| Health from the VM | `curl http://127.0.0.1:8080/health` |
| Rotate the HMAC secret | Set `ENQUEUE_HMAC_SECRET_PREVIOUS` to the old value and `ENQUEUE_HMAC_SECRET` to the new one, restart, update Vercel, then remove `…_PREVIOUS` and restart again |

- **Changing the R2 account or the Neon host** changes the allowlist: restart the stack so the gateway reads the env file again.
- **If the egress container restarts on its own**, the worker keeps the old network namespace with its rules but loses DNS, so jobs fail and retry. `sudo systemctl restart gitinside` recreates both.
- **Host firewall:** Oracle's Ubuntu image keeps its rules in `/etc/iptables/rules.v4` (SSH in, everything else rejected). Docker adds its own chains when it starts; after reloading the saved rules, run `sudo systemctl restart docker gitinside`.
- **Idle reclamation:** Oracle may reclaim an idle Always Free VM. Never generate artificial load to prevent it. Rebuild instead.
