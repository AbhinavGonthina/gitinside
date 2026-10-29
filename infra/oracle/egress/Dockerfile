# The worker's egress gateway (docs/SECURITY.md T4, ADR-0075): dnsmasq plus the iptables
# rules of entrypoint.sh, in the network namespace the worker joins. Built by
# infra/oracle/compose.yml.
FROM alpine:3.22
RUN apk add --no-cache dnsmasq ipset iptables
COPY --chmod=0555 entrypoint.sh /usr/local/bin/egress-entrypoint
ENTRYPOINT ["/usr/local/bin/egress-entrypoint"]
