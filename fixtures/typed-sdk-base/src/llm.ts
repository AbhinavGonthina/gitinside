import OpenAI from "openai";

/** A typed field set in the constructor: how the client was built counts, not its type. */
export class LocalModel {
  private openai: OpenAI;

  constructor() {
    this.openai = new OpenAI({ baseURL: "http://localhost:11434/v1" });
  }

  chat(prompt: string) {
    return this.openai.chat.completions.create({
      model: "llama3",
      messages: [{ role: "user", content: prompt }],
    });
  }
}

const groq: OpenAI = new OpenAI({ baseURL: "https://api.groq.com/openai/v1" });

export function fastChat(prompt: string) {
  return groq.chat.completions.create({
    model: "llama-3.1-8b-instant",
    messages: [{ role: "user", content: prompt }],
  });
}

/** Known only by its type: whoever builds it picks the base. */
export class Embedder {
  constructor(private readonly ai: OpenAI) {}

  embed(input: string) {
    return this.ai.embeddings.create({ model: "text-embedding-3-small", input });
  }
}

/** Two branches with different bases: which one runs is only known at runtime. */
const router = process.env.USE_OPENROUTER
  ? new OpenAI({ baseURL: "https://openrouter.ai/api/v1" })
  : new OpenAI();

export function routedChat(prompt: string) {
  return router.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
  });
}

/** A test helper reading a mocked method's calls: not a request. */
export function lastFastChat() {
  return (groq.chat.completions.create as unknown as { mock: { calls: unknown[][] } }).mock.calls.at(-1);
}
