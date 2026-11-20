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

/**
 * A store through another class's type: types are structural, so a `Planner` may be passed as
 * a `Badge`, and `pin` may replace its client (M13.1a).
 */
export class Planner {
  ai = new OpenAI();
  label = "plan";

  models() {
    return this.ai.models.list();
  }
}

export class Badge {
  ai?: OpenAI;
  label = "";
}

export function pin(badge: Badge, client: OpenAI) {
  badge.ai = client;
}

/** No store's type can hold an `Archivist` (each needs a member it lacks), so its client stays. */
export class Archivist {
  ai = new OpenAI();

  history() {
    return this.ai.models.list();
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
