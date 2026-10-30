#!/usr/bin/env bash
# Provisions, updates, or rebuilds the worker VM: Ubuntu 24.04 on an Oracle Always Free
# A1 shape (infra/oracle/README.md, docs/SECURITY.md §3, ADR-0075). Run as root; running
# it again is safe and is how the VM is updated:
#
#   sudo /opt/gitinside/infra/oracle/provision.sh [--ref <git ref>]
#
# Steps: Docker Engine + Compose from Docker's apt repository, the kernel modules the
# egress gateway needs, time sync (the enqueue signatures allow ±5 min), a host firewall
# check, the checkout at /opt/gitinside (default origin/main), the root-only env file
# /etc/gitinside/worker.env (created from apps/worker/.env.example on the first run,
# which then stops so the values can be filled in), the Redis password in
# /etc/gitinside/redis.env (generated once), the egress gateway's host names in
# /etc/gitinside/egress.hosts (derived from worker.env), the images, the database
# migrations, and a systemd unit that starts the stack at boot. It never prints a secret.
set -euo pipefail

REPO_URL=${REPO_URL:-https://github.com/AbhinavGonthina/gitinside.git}
DIR=/opt/gitinside
ENV_DIR=/etc/gitinside
ENV_FILE=$ENV_DIR/worker.env
REDIS_ENV_FILE=$ENV_DIR/redis.env
HOSTS_FILE=$ENV_DIR/egress.hosts
UNIT=/etc/systemd/system/gitinside.service
MODULES=(ip_set ip_set_hash_ip xt_set xt_owner)
REQUIRED=(DATABASE_URL SNAPSHOTS_NAMESPACE SNAPSHOTS_REGION SNAPSHOTS_ACCESS_KEY_ID
  SNAPSHOTS_SECRET_ACCESS_KEY SNAPSHOTS_BUCKET ENQUEUE_HMAC_SECRET)
# Applies the migrations from inside the worker image, through the egress gateway.
MIGRATE='import { runMigrations } from "@gitinside/db";
await runMigrations(process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL);
console.log("migrations applied");'

step() {
  printf '\n==> %s\n' "$*"
}

fail() {
  printf 'provision: %s\n' "$*" >&2
  exit 1
}

# Everything runs from this function, so bash has read the whole script before the
# checkout step replaces it on disk.
main() {
  local ref=origin/main
  while [[ $# -gt 0 ]]; do
    case $1 in
      --ref)
        ref=${2:?--ref needs a value}
        shift 2
        ;;
      -h | --help)
        sed -n '2,15p' "$0"
        exit 0
        ;;
      *) fail "unknown argument: $1" ;;
    esac
  done

  [[ $EUID -eq 0 ]] || fail "run as root (sudo)"
  # shellcheck source=/dev/null
  . /etc/os-release
  [[ ${ID:-} == ubuntu ]] || fail "expected Ubuntu, found ${ID:-unknown}"

  step "Packages: git, Docker Engine, Compose"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q
  apt-get install -y -q ca-certificates curl git openssl
  install -m 0755 -d /etc/apt/keyrings
  if [[ ! -s /etc/apt/keyrings/docker.asc ]]; then
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
  fi
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    >/etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker

  step "Kernel modules for the egress gateway (ipset, owner match)"
  if ! modprobe -n -q ip_set; then
    apt-get install -y -q "linux-modules-extra-$(uname -r)"
  fi
  printf '%s\n' "${MODULES[@]}" >/etc/modules-load.d/gitinside.conf
  modprobe -a "${MODULES[@]}"

  step "Time sync"
  timedatectl set-ntp true

  step "Host firewall"
  # The OCI security list is the outer wall (443 from anywhere, 22 from Abhinav's IP).
  # Oracle's Ubuntu image also rejects everything but SSH in the host's INPUT chain
  # (/etc/iptables/rules.v4); Caddy's published 443 goes through Docker's FORWARD chains.
  if [[ $(iptables -S INPUT | head -n 1) != "-P INPUT DROP" ]] &&
    ! iptables -S INPUT | grep -Eq -- '-j (REJECT|DROP)'; then
    fail "the host's INPUT chain accepts everything; restore Oracle's /etc/iptables/rules.v4 (README.md)"
  fi

  step "Checkout of $REPO_URL at $ref"
  if [[ ! -d $DIR/.git ]]; then
    git clone --quiet "$REPO_URL" "$DIR"
  fi
  git -C "$DIR" fetch --quiet --tags --force origin
  git -C "$DIR" checkout --quiet --detach "$ref"
  git -C "$DIR" log -1 --format='now at %h %s'

  step "Env file $ENV_FILE"
  install -d -m 0700 -o root -g root "$ENV_DIR"
  if [[ ! -e $ENV_FILE ]]; then
    install -m 0600 -o root -g root "$DIR/apps/worker/.env.example" "$ENV_FILE"
    echo "Created $ENV_FILE from apps/worker/.env.example."
    echo "Fill in its values (infra/oracle/README.md), then run this script again."
    exit 2
  fi
  chown root:root "$ENV_FILE"
  chmod 0600 "$ENV_FILE"
  local name missing=()
  for name in "${REQUIRED[@]}"; do
    grep -Eq "^${name}=.+" "$ENV_FILE" || missing+=("$name")
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    fail "$ENV_FILE has no value for: ${missing[*]}"
  fi

  step "Redis password $REDIS_ENV_FILE"
  # Generated once and kept; delete the file and run this again to rotate it (ADR-0083).
  if ! grep -Eq '^REDIS_PASSWORD=[0-9a-f]{64}$' "$REDIS_ENV_FILE" 2>/dev/null; then
    (
      umask 077
      printf 'REDIS_PASSWORD=%s\n' "$(openssl rand -hex 32)" >"$REDIS_ENV_FILE"
    )
    echo "Generated a new Redis password."
  fi
  chown root:root "$REDIS_ENV_FILE"
  chmod 0600 "$REDIS_ENV_FILE"

  step "Egress host names $HOSTS_FILE"
  sh "$DIR/infra/oracle/egress-hosts.sh" "$ENV_FILE" "$HOSTS_FILE"

  local compose=(docker compose -f "$DIR/infra/oracle/compose.yml")

  step "Images (built on this VM from the checkout)"
  "${compose[@]}" build --pull

  step "Database migrations"
  "${compose[@]}" up -d --wait egress
  "${compose[@]}" run --rm --no-deps -T worker node --input-type=module -e "$MIGRATE"

  step "systemd unit $UNIT"
  cat >"$UNIT" <<EOF
[Unit]
Description=GitInside worker stack (infra/oracle/compose.yml)
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$DIR
# Host names re-derived at every start, so an edited $ENV_FILE needs only a restart.
ExecStartPre=/bin/sh $DIR/infra/oracle/egress-hosts.sh $ENV_FILE $HOSTS_FILE
ExecStart=/usr/bin/docker compose -f infra/oracle/compose.yml up -d --build --remove-orphans --wait
ExecStop=/usr/bin/docker compose -f infra/oracle/compose.yml down
TimeoutStartSec=20min
TimeoutStopSec=2min

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable gitinside.service
  systemctl restart gitinside.service

  step "Status"
  "${compose[@]}" ps
  echo
  echo "Done. From outside: curl https://worker.gitinside.abhinavgonthina.dev/health"
}

main "$@"
