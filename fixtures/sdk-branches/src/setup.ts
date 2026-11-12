import OpenAI from "openai";

const slots = globalThis as unknown as { proxied?: OpenAI };

/** Puts a client for the company proxy where `lazy.ts` looks for its cache. */
export function useProxy(): void {
  slots.proxied = new OpenAI({ baseURL: process.env.PROXY_BASE_URL });
}
