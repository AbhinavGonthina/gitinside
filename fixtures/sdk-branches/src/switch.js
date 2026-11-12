const { OpenAI } = require("openai");

/** Each `this.ai = …` write declares the field: either client may make the call. */
class LocalOrCloud {
  constructor(local) {
    if (local) this.ai = new OpenAI({ baseURL: "http://localhost:11434/v1" });
    else this.ai = new OpenAI();
  }

  models() {
    return this.ai.models.list();
  }
}

/** Built lazily, once: the self-reference adds no branch. */
class Lazy {
  constructor() {
    this.ai = null;
  }

  chat(prompt) {
    this.ai = this.ai || new OpenAI({ baseURL: "https://api.groq.com/openai/v1" });
    return this.ai.chat.completions.create({ messages: [{ role: "user", content: prompt }] });
  }
}

/** A client the caller may pass in, built with any base. */
function clientFor(opts) {
  return opts.client || new OpenAI({ baseURL: "https://api.groq.com/openai/v1" });
}

function embed(opts, input) {
  return clientFor(opts).embeddings.create({ input });
}

/** Built with no options, but a setter may swap in a client with any base. */
class Pluggable {
  constructor() {
    this.ai = new OpenAI();
  }

  setClient(client) {
    this.ai = client;
  }

  models() {
    return this.ai.models.list();
  }
}

/** Nothing here caches a client on `window`, so another script may have put any one there. */
const shared = window.openai ?? new OpenAI();

function sharedModels() {
  return shared.models.list();
}

module.exports = { LocalOrCloud, Lazy, embed, Pluggable, sharedModels };
