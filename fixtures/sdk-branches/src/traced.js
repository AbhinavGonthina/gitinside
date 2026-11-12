const { OpenAI } = require("openai");

/** Two values the caller passes, joined: either may be a client with any base. */
function pickModels(opts) {
  const client = opts.ai ?? opts.fallback;
  return (client ?? new OpenAI()).models.list();
}

/** A destructuring default stores the caller's client whenever it passes one. */
let injected;

function inject(deps) {
  ({ ai: injected = new OpenAI() } = deps);
}

function injectedModels() {
  return (injected ??= new OpenAI()).models.list();
}

/** The stored value keeps what was there, or else the caller's client: no cache. */
function adopt(client) {
  globalThis.adopted = globalThis.adopted || client;
}

function adoptedModels() {
  return (globalThis.adopted ??= new OpenAI()).models.list();
}

/** Every branch is built here, so the call goes to OpenAI's default host. */
function builtModels(flag) {
  const client = flag ? new OpenAI() : new OpenAI();
  return client.models.list();
}

module.exports = { pickModels, inject, injectedModels, adopt, adoptedModels, builtModels };
