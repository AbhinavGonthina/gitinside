import OpenAI from "openai";

/** `holder.settings` may be replaced by a copy holding the caller's client (M13.1c). */
const defaults = { writer: new OpenAI() };
const holder = { settings: defaults };

export function reconfigure(opts: Partial<typeof defaults>) {
  holder.settings = { ...defaults, ...opts };
}

export function holderModels() {
  return holder.settings.writer.models.list();
}

/** `reviewer`'s methods may run on a copy with another `critic` (M13.1c). */
export const reviewer = {
  critic: new OpenAI(),
  review() {
    return this.critic.models.list();
  },
};

export function customReviewer(critic: OpenAI) {
  return { ...reviewer, critic };
}

/** A literal may be passed as a `Ledger`, whose only member is `book` (M13.1c). */
export class Ledger {
  book = new OpenAI();
}

export function ledgerModels(ledger: Ledger) {
  return ledger.book.models.list();
}

export const borrowedLedger = (book: OpenAI) => ledgerModels({ book });

/** A nested `const` literal no store reaches is read through, so its client stays. */
const toolbox = { drafting: { pencil: new OpenAI() } };

export function toolboxModels() {
  return toolbox.drafting.pencil.models.list();
}
