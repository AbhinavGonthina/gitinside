import Anthropic from "@anthropic-ai/sdk";
import { Octokit } from "@octokit/rest";
import { App, Octokit as Kit } from "octokit";
import OpenAI from "openai";

/** A write beside the initializer replaces the client it built. */
export class Switchable {
  private ai = new OpenAI();

  useGroq() {
    this.ai = new OpenAI({ baseURL: "https://api.groq.com/openai/v1" });
  }

  models() {
    return this.ai.models.list();
  }
}

/** A module's cache of the one client it builds, kept on the global object. */
const cache = globalThis as unknown as { router?: OpenAI };
export const router = cache.router ?? new OpenAI({ baseURL: "https://openrouter.ai/api/v1" });
cache.router = router;

export function route(prompt: string) {
  return router.chat.completions.create({
    model: "openai/gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
  });
}

/** Clients of two packages: which API a call reaches is only known at runtime. */
const assistant = process.env.USE_CLAUDE ? new Anthropic() : new OpenAI();

export function listModels() {
  return assistant.models.list();
}

/** The example file's value is a placeholder, so it names no outside API. */
const azure = new OpenAI({ baseURL: process.env.AZURE_BASE_URL });

export function azureChat(prompt: string) {
  return azure.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: prompt }],
  });
}

/** A client the caller may pass, beside one built with only a token: either base is possible. */
export function repoFor(given: unknown, owner: string, repo: string) {
  const github = (given as Octokit | undefined) ?? new Octokit({ auth: process.env.GITHUB_TOKEN });
  return github.repos.get({ owner, repo });
}

const app = new App({ appId: 1, privateKey: process.env.GITHUB_APP_KEY ?? "" });

/** A caller's client, the App's, or one built with a token: in any order, any base is possible. */
export function issuesFor(opts: { gh?: unknown; token?: string }, owner: string, repo: string) {
  const github = (opts.gh as Kit | undefined) ?? app.octokit ?? new Kit({ auth: opts.token });
  return github.rest.issues.listForRepo({ owner, repo });
}
