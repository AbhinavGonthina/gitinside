import OpenAI from "openai";

/** The proxy's upstream: `.env.example` names OpenAI's host, not the repo's own endpoint. */
const upstream = new OpenAI({ baseURL: process.env.UPSTREAM_BASE_URL });

export function relay(prompt: string) {
  return upstream.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
  });
}
