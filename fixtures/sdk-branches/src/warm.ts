import OpenAI from "openai";

declare global {
  var sharedAI: OpenAI | undefined;
}

let cached: OpenAI | undefined;

/** A caller may swap in its own client. */
export function setCached(c: OpenAI) {
  cached = c;
}

function getCached() {
  return cached ?? new OpenAI();
}

/** Writes the getter's result back to the variable it reads, then uses it. */
export async function warm() {
  cached = getCached();
  return cached.models.list();
}

export function cachedModels() {
  return getCached().models.list();
}

/** `sharedAI` is a global `var`, so this stores at `globalThis.sharedAI`. */
export function share(c: OpenAI) {
  sharedAI = c;
}

export const getShared = () => (globalThis.sharedAI ??= new OpenAI());

export function sharedModels() {
  return getShared().models.list();
}
