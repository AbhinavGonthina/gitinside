import OpenAI from "openai";

const g = globalThis as unknown as { lazyAI?: OpenAI; proxied?: OpenAI };

/** Built on first use and kept on the global object; nothing else writes it. */
export const getAI = () => (g.lazyAI ??= new OpenAI());

export function lazyModels() {
  return getAI().models.list();
}

/** Cached here, but `setup.ts` stores a client with another base at the same path. */
export const proxied = g.proxied ?? new OpenAI();
g.proxied = proxied;

export function proxiedModels() {
  return proxied.models.list();
}

let client: OpenAI | undefined;

/** A caller may swap in its own client, so the lazy getter's may have any base. */
export function setClient(c: OpenAI) {
  client = c;
}

export const getClient = () => (client ??= new OpenAI());

export function clientModels() {
  return getClient().models.list();
}
