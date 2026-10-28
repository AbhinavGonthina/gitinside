import dgram from "node:dgram";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";

/**
 * Network guard for the analysis child process, preloaded with `--import` before any other
 * module (docs/SECURITY.md T4, ADR-0059).
 *
 * The analyzer never needs the network: the worker downloads the tarball before forking.
 * This guard turns any attempt into an immediate `ERR_NETWORK_DISABLED` error, so a bug
 * (or a future plugin) can't make requests from the process that holds untrusted input.
 *
 * Blocks: TCP and TLS sockets (`net.Socket#connect`, `net.connect`, `net.createConnection`,
 * `tls.connect`), listening (`net.Server#listen`), UDP (`dgram.createSocket`, `bind`,
 * `send`), `http`/`https` `request`/`get`, every `dns` lookup and resolve function (callback
 * and promise forms, and `dns.Resolver`), and the globals `fetch`, `WebSocket`, and
 * `EventSource`. Replacements are non-writable, and ESM named imports are re-synced.
 *
 * Doesn't block: native bindings (the permission model already refuses addons and child
 * processes), or anything outside this process. It is defense in depth inside the process;
 * the container's egress allowlist (M5.10) is the boundary that holds against an attacker.
 */

const ERROR_CODE = "ERR_NETWORK_DISABLED";

function denied(what: string): Error {
  return Object.assign(new Error(`network access is disabled in the analysis process (${what})`), {
    code: ERROR_CODE,
  });
}

/** Replace `target[key]` with a function that throws, so nothing can put the original back. */
function block(target: object, key: string, what: string): void {
  Object.defineProperty(target, key, {
    value: function blocked(): never {
      throw denied(what);
    },
    writable: false,
    configurable: false,
    enumerable: true,
  });
}

block(net.Socket.prototype, "connect", "net.Socket#connect");
block(net, "connect", "net.connect");
block(net, "createConnection", "net.createConnection");
block(net.Server.prototype, "listen", "net.Server#listen");
block(tls, "connect", "tls.connect");
block(dgram, "createSocket", "dgram.createSocket");
block(dgram.Socket.prototype, "bind", "dgram.Socket#bind");
block(dgram.Socket.prototype, "send", "dgram.Socket#send");
for (const client of [http, https]) {
  block(client, "request", "http.request");
  block(client, "get", "http.get");
}

const DNS_FUNCTIONS = [
  "lookup",
  "lookupService",
  "resolve",
  "resolve4",
  "resolve6",
  "resolveAny",
  "resolveCaa",
  "resolveCname",
  "resolveMx",
  "resolveNaptr",
  "resolveNs",
  "resolvePtr",
  "resolveSoa",
  "resolveSrv",
  "resolveTxt",
  "reverse",
];
for (const target of [dns, dns.promises, dns.Resolver.prototype, dns.promises.Resolver.prototype]) {
  for (const key of DNS_FUNCTIONS) {
    if (key in target) block(target, key, `dns.${key}`);
  }
}

Object.defineProperty(globalThis, "fetch", {
  value: function fetch(): Promise<never> {
    return Promise.reject(denied("fetch"));
  },
  writable: false,
  configurable: false,
});
for (const key of ["WebSocket", "EventSource"]) {
  if (key in globalThis) block(globalThis, key, key);
}

syncBuiltinESMExports();
