#!/bin/sh
# Writes the egress gateway's hosts file from the worker's env file (ADR-0075, ADR-0083), so
# the gateway never sees a secret: it gets host names only, one per line.
#
#   sh infra/oracle/egress-hosts.sh <worker env file> <hosts file>
#
# The hosts: <SNAPSHOTS_NAMESPACE>.compat.objectstorage.<SNAPSHOTS_REGION>.oraclecloud.com
# (Oracle Object Storage's S3-compatible API, ADR-0095) and the hosts of DATABASE_URL /
# DATABASE_URL_UNPOOLED (single-label names, such as CI's `postgres` service, are the
# stack's own and reached over the internal network, so they're left out). GitHub's two
# hosts are fixed in the gateway itself. provision.sh runs this, and so does the systemd
# unit before every start, so an edited env file takes effect on the next restart. Values
# are never printed; only host names are.
set -eu

ENV_FILE=${1:?usage: egress-hosts.sh <worker env file> <hosts file>}
OUT=${2:?usage: egress-hosts.sh <worker env file> <hosts file>}

fail() {
  echo "egress-hosts: $*" >&2
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

# The snapshot bucket's endpoint, built from the namespace and region as storage.ts builds
# it (`oracleS3Host`). Both must be lowercase DNS labels joined by hyphens, as storage.ts
# requires, so neither can add a dot (another domain) or anything else to the name.
# The letters are spelled out: a range like a-z can match capitals in some locales.
namespace=$(value SNAPSHOTS_NAMESPACE)
case $namespace in
  '' | -* | *- | *[!0123456789abcdefghijklmnopqrstuvwxyz-]*)
    fail "SNAPSHOTS_NAMESPACE is empty or not a namespace" ;;
esac
region=$(value SNAPSHOTS_REGION)
case $region in
  '' | -* | *- | *--* | *[!0123456789abcdefghijklmnopqrstuvwxyz-]*)
    fail "SNAPSHOTS_REGION is empty or not a region identifier" ;;
esac
hosts="$namespace.compat.objectstorage.$region.oraclecloud.com"

for name in DATABASE_URL DATABASE_URL_UNPOOLED; do
  url=$(value "$name")
  [ -n "$url" ] || continue
  host=$(url_host "$url")
  case $host in
    '') fail "$name has no host" ;;
    *[!a-z0-9.-]*) fail "$name has an unexpected host" ;;
    *.*) hosts="$hosts $host" ;;
    *) ;;
  esac
done

# Written next to the target and renamed over it, so the gateway never reads half a file.
# Host names aren't secret, and the gateway's root (no CAP_DAC_OVERRIDE) must read it
# whoever owns it, so it's world-readable.
tmp="$OUT.tmp.$$"
# shellcheck disable=SC2086 # split on purpose: one host per line
printf '%s\n' $hosts | sort -u >"$tmp"
chmod 0644 "$tmp"
mv -f "$tmp" "$OUT"
echo "egress-hosts: $(tr '\n' ' ' <"$OUT")"
