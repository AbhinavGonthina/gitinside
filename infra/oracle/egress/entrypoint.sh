#!/bin/sh
# The worker's egress gateway (docs/SECURITY.md T4, ADR-0075). The worker container joins
# this container's network namespace (compose: `network_mode: service:egress`), so these
# rules are the worker's too, and the worker (uid 1000, no capabilities) can't change them.
#
# - DNS: dnsmasq on 127.0.0.1 forwards only the allowlisted names, plus the stack's own
#   single-label service names (`redis`), to Docker's resolver. Everything else is NXDOMAIN.
#   Every IPv4 address it hands out for an allowlisted name goes into the `gitinside-allow`
#   ipset; AAAA answers are dropped.
# - Out: TCP to an address in that set on 443 (HTTPS) or 5432 (Postgres), anything to the
#   stack's internal network, and DNS from root (dnsmasq, Docker's resolver). Everything
#   else is rejected, and IPv6 is dropped. Docker's resolver (127.0.0.11) answers any name,
#   so only root may ask it.
#
# The allowlist: api.github.com, codeload.github.com, <R2_ACCOUNT_ID>.r2.cloudflarestorage.com,
# and the hosts of DATABASE_URL / DATABASE_URL_UNPOOLED, read from the worker's env file.
# Values are never printed; only host names are.
set -eu

ENV_FILE=${EGRESS_ENV_FILE:-/etc/gitinside/worker.env}
INTERNAL_SUBNET=${EGRESS_INTERNAL_SUBNET:?EGRESS_INTERNAL_SUBNET is not set}
SET=gitinside-allow
RUN_DIR=/run/egress
CONF=$RUN_DIR/dnsmasq.conf

fail() {
  echo "egress: $*" >&2
  exit 1
}

# The last value of the variable $1 in the env file, without surrounding quotes.
value() {
  sed -n "s/^[[:space:]]*$1[[:space:]]*=//p" "$ENV_FILE" | tail -n 1 |
    sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

# The lowercase host of a URL (`scheme://[user[:password]@]host[:port][/…]`).
url_host() {
  printf '%s\n' "$1" |
    sed -n 's|^[A-Za-z][A-Za-z0-9+.-]*://\([^@/]*@\)\{0,1\}\([^:/?#]*\).*$|\2|p' |
    tr '[:upper:]' '[:lower:]'
}

[ -r "$ENV_FILE" ] || fail "can't read the worker's env file ($ENV_FILE)"

hosts="api.github.com codeload.github.com"

account=$(value R2_ACCOUNT_ID | tr '[:upper:]' '[:lower:]')
case $account in
  '' | *[!0-9a-z]*) fail "R2_ACCOUNT_ID is empty or not an account ID" ;;
esac
hosts="$hosts $account.r2.cloudflarestorage.com"

for name in DATABASE_URL DATABASE_URL_UNPOOLED; do
  url=$(value "$name")
  [ -n "$url" ] || continue
  host=$(url_host "$url")
  case $host in
    '') fail "$name has no host" ;;
    *[!a-z0-9.-]*) fail "$name has an unexpected host" ;;
    *.*) hosts="$hosts $host" ;;
    *) ;; # a service of this stack (CI's Postgres), reached over the internal network
  esac
done

# shellcheck disable=SC2086 # split on purpose: one host per line
hosts=$(printf '%s\n' $hosts | sort -u | tr '\n' ' ')
echo "egress: allowing ${hosts% } and $INTERNAL_SUBNET"

mkdir -p "$RUN_DIR"
{
  echo "no-resolv"
  echo "no-hosts"
  echo "listen-address=127.0.0.1"
  echo "bind-interfaces"
  echo "user=root"
  echo "filter-AAAA"
  echo "cache-size=1000"
  echo "log-facility=-"
  echo "local=/#/"
  echo "server=//127.0.0.11"
  for host in $hosts; do
    echo "server=/$host/127.0.0.11"
  done
  echo "ipset=/$(printf '%s' "${hosts% }" | tr ' ' '/')/$SET"
} >"$CONF"

ipset create "$SET" hash:ip family inet -exist

iptables -P OUTPUT DROP
iptables -F OUTPUT
iptables -A OUTPUT -d 127.0.0.11 -m owner ! --uid-owner 0 -j REJECT
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -d "$INTERNAL_SUBNET" -j ACCEPT
iptables -A OUTPUT -p udp --dport 53 -m owner --uid-owner 0 -j ACCEPT
iptables -A OUTPUT -p tcp --dport 53 -m owner --uid-owner 0 -j ACCEPT
iptables -A OUTPUT -p tcp -m multiport --dports 443,5432 -m set --match-set "$SET" dst -j ACCEPT
iptables -A OUTPUT -p tcp -j REJECT --reject-with tcp-reset
iptables -A OUTPUT -j REJECT --reject-with icmp-admin-prohibited

if ip6tables -S OUTPUT >/dev/null 2>&1; then
  ip6tables -P OUTPUT DROP
  ip6tables -F OUTPUT
  ip6tables -A OUTPUT -o lo -j ACCEPT
elif [ "$(cat /proc/sys/net/ipv6/conf/all/disable_ipv6 2>/dev/null || echo 1)" != 1 ]; then
  fail "IPv6 is on and ip6tables is unavailable"
fi

touch "$RUN_DIR/ready"
exec dnsmasq --keep-in-foreground --conf-file="$CONF"
