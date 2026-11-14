// @vitest-environment node
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HOST_GROUPS, HOST_GROUPS_VERSION, hostGroupFor, OTHER_HOSTS } from "./hostGroups.js";

const slug = (host: string) => hostGroupFor(host).slug;

describe("hostGroupFor", () => {
  it("groups a host by its registrable suffix, subdomains included", () => {
    expect(slug("api.openai.com")).toBe("ai");
    expect(slug("openai.com")).toBe("ai");
    expect(slug("files.stripe.com")).toBe("payments");
    expect(slug("email.amazonaws.com")).toBe("email");
    expect(slug("raw.githubusercontent.com")).toBe("code");
    expect(hostGroupFor("api.anthropic.com").title).toBe("AI models");
  });

  it("matches only at a label boundary, and the longest suffix wins", () => {
    expect(hostGroupFor("notopenai.com")).toEqual(OTHER_HOSTS);
    expect(slug("maps.googleapis.com")).toBe("maps");
    expect(slug("sheets.googleapis.com")).toBe("productivity");
    expect(slug("generativelanguage.googleapis.com")).toBe("ai");
    // A provider's generic host serves many products: no group.
    expect(hostGroupFor("www.googleapis.com")).toEqual(OTHER_HOSTS);
    expect(hostGroupFor("ai.azure.com.evil.example")).toEqual(OTHER_HOSTS);
  });

  it("ignores case, a port, and a trailing dot, and never guesses from a name", () => {
    expect(slug("API.OpenAI.com:443")).toBe("ai");
    expect(slug("api.groq.com.")).toBe("ai");
    expect(hostGroupFor("api.keenable.ai")).toEqual(OTHER_HOSTS);
    expect(hostGroupFor("localhost")).toEqual(OTHER_HOSTS);
  });
});

describe("HOST_GROUPS", () => {
  it("lists each suffix once, lowercase, sorted within its group, with unique slugs", () => {
    const all = HOST_GROUPS.flatMap((g) => g.suffixes);
    expect(new Set(all).size).toBe(all.length);
    for (const g of HOST_GROUPS) {
      expect(g.suffixes).toEqual([...g.suffixes].sort());
      for (const s of g.suffixes) expect(s).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/);
    }
    const slugs = [...HOST_GROUPS.map((g) => g.slug), OTHER_HOSTS.slug];
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const s of slugs) expect(s).toMatch(/^[a-z]+$/);
  });

  it("is pinned to its version: bump HOST_GROUPS_VERSION and this digest together", () => {
    const digest = createHash("sha256").update(JSON.stringify(HOST_GROUPS)).digest("hex");
    expect({ version: HOST_GROUPS_VERSION, digest: digest.slice(0, 16) }).toEqual({
      version: 1,
      digest: "9ac86f8bf4191eb3",
    });
  });
});
