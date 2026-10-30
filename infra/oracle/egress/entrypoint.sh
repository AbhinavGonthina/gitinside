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
# The allowlist: api.github.com, codeload.github.com, and the hosts in the hosts file, which
# infra/oracle/egress-hosts.sh derives from the worker's env file (the bucket's endpoint and the
# database hosts). The gateway never sees the env file or any secret (ADR-0083).
set -eu

HOSTS_FILE=${EGRESS_HOSTS_FILE:-/etc/gitinside/egress.hosts}
INTERNAL_SUBNET=${EGRESS_INTERNAL_SUBNET:?EGRESS_INTERNAL_SUBNET is not set}
SET=gitinside-allow
RUN_DIR=/run/egress
CONF=$RUN_DIR/dnsmasq.conf

fail() {
  echo "egress: $*" >&2
  exit 1
}

[ -r "$HOSTS_FILE" ] || fail "can't read the hosts file ($HOSTS_FILE)"

hosts="api.github.com codeload.github.com"

# One lowercase DNS name with a dot per line; blank lines are skipped. Anything else stops
# the gateway, so a bad file can't widen the allowlist (dnsmasq syntax, wildcards).
while IFS= read -r host || [ -n "$host" ]; do
  case $host in
    '') ;;
    *[!a-z0-9.-]* | .* | *. | *..*) fail "the hosts file has an unexpected line" ;;
    *.*) hosts="$hosts $host" ;;
    *) fail "the hosts file has a name without a dot" ;;
  esac
done <"$HOSTS_FILE"

# shellcheck disable=SC2086 # split on purpose: one host per line
hosts=$(printf '%s\n' $hosts | sort -u | tr '\n' ' ')
echo "egress: allowing ${hosts% } and $INTERNAL_SUBNET"

mkdir -p "$RUN_DIR"
{
  echo "no-resolv"
  echo "no-hosts"
  echo "listen-address=127.0.0.1"
  echo "bind-interfaces"
  # Stay root (no CAP_SETUID/SETGID to switch): the DNS rule below allows root only. An
  # empty group means no group change at all (even to root's, setgid needs CAP_SETGID).
  echo "user=root"
  echo "group="
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
