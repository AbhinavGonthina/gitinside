import OpenAI from "openai";

/**
 * A subclass declares its own field of the same name as a parameter property, so `speak` on a
 * `GuestNarrator` reads the caller's client (M13.1b).
 */
export class Narrator {
  voice: OpenAI = new OpenAI();

  speak() {
    return this.voice.models.list();
  }
}

export class GuestNarrator extends Narrator {
  constructor(public override voice: OpenAI) {
    super();
  }
}

/** A constant key names the member it stores to, even through `any` (M13.1b). */
const SLOT = "engine";

export class Turbine {
  engine = new OpenAI();

  spin() {
    return this.engine.models.list();
  }
}

export function swapEngine(turbine: Turbine, client: OpenAI) {
  (turbine as any)[SLOT] = client;
}

/** A `declare` field emits no code, so `Scribe`'s own client stays. */
export class Scribe {
  pen = new OpenAI();

  write() {
    return this.pen.models.list();
  }
}

export class QuietScribe extends Scribe {
  declare pen: OpenAI;
}
