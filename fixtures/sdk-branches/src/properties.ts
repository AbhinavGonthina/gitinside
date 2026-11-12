import OpenAI from "openai";

/** A field another function stores into: the caller's client may replace the default one. */
export class Assistant {
  ai = new OpenAI();

  models() {
    return this.ai.models.list();
  }
}

export function plugIn(assistant: Assistant, client: OpenAI) {
  assistant.ai = client;
}

/** Another class's field of the same name: stores to it never reach `Assistant`'s. */
export class Recorder {
  ai?: OpenAI;

  record(client: OpenAI) {
    this.ai = client;
  }
}

/** A module object's member, replaced by `configure`. */
const settings = { llm: new OpenAI() };

export function configure(client: OpenAI) {
  settings.llm = client;
}

export function settingsModels() {
  return settings.llm.models.list();
}

/** An object literal's method reads its own member through `this`; nothing else stores it. */
export const helper = {
  llm: new OpenAI(),
  models() {
    return this.llm.models.list();
  },
};
