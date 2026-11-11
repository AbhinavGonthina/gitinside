import { DEFAULT_LIMITS, SOURCE_EXTENSIONS } from "@gitinside/analyzer";
import { ACCESS_TTL_SECONDS, COMPUTE_PAUSE_RATIO, PR_PIN_DAYS } from "@gitinside/db";
import { DEFAULT_RUNNER_LIMITS, RETENTION_POLICY } from "@gitinside/worker";
import { DEFAULT_EXTRACT_LIMITS } from "@gitinside/worker/extract";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REPO_ANALYSIS_MINUTES } from "../lib/analyze";
import { CHALLENGE_AFTER_PER_ADDRESS, CHALLENGE_AFTER_SITE } from "../lib/botCheck";
import { MAX_GITHUB_CODE_BYTES } from "../lib/codeSize";
import { DOCS_PAGES, repoFile } from "../lib/docs";
import { ANALYSIS_TIME_LIMIT, SUPPORTED_SOURCE_FILES, SUPPORTED_SOURCE_MB } from "../lib/limits";
import { RECHECKS_PER_HOUR } from "../lib/repoView";
import { SIGNED_IN_HOURLY_LIMIT, SIGNED_OUT_HOURLY_LIMIT } from "../lib/serverDeps";
import { SIZE_HOLD_DAYS } from "../lib/sizeHold";
import {
  SESSION_COOKIE,
  SESSION_LIFETIME_SECONDS,
  STATE_COOKIE,
  STATE_LIFETIME_SECONDS,
} from "../lib/session";
import { THEME_COOKIE, themeCookie } from "../lib/theme";
import HowItWorks, { metadata as howMetadata } from "./how-it-works/page";
import { Landing } from "./Landing";
import Limits, { metadata as limitsMetadata } from "./limits/page";
import Privacy, { metadata as privacyMetadata } from "./privacy/page";
import SelfHosting, { metadata as selfHostingMetadata } from "./self-hosting/page";

// The landing page's field uses the router.
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

afterEach(cleanup);

const PAGES = [
  ["/how-it-works", HowItWorks, howMetadata],
  ["/limits", Limits, limitsMetadata],
  ["/privacy", Privacy, privacyMetadata],
  ["/self-hosting", SelfHosting, selfHostingMetadata],
] as const;

const MIB = 1024 * 1024;

/** The page's text as a reader sees it: no-break spaces as spaces, runs of space as one. */
function text(): string {
  return plain(document.body.textContent ?? "");
}

/** `s` with no-break spaces as spaces and runs of space as one (`\s` matches U+00A0). */
function plain(s: string): string {
  return s.replace(/\s+/g, " ");
}

/** The footer's links, as [name, href]. */
function footerLinks(): [string | null, string | null][] {
  const nav = screen.getByRole("navigation", { name: "About GitInside" });
  return within(nav)
    .getAllByRole("link")
    .map((a) => [a.textContent, a.getAttribute("href")]);
}

const FOOTER = [
  ["How it works", "/how-it-works"],
  ["Limits", "/limits"],
  ["Privacy", "/privacy"],
  ["Self-hosting", "/self-hosting"],
  ["Source on GitHub", "https://github.com/AbhinavGonthina/gitinside"],
];

describe("docs pages (M9.4a)", () => {
  it("lists every page once, nav and routes alike", () => {
    expect(DOCS_PAGES.map((p) => p.href)).toEqual(PAGES.map(([href]) => href));
  });

  it.each(PAGES)("%s: titled, its tab marked current, the footer below", (href, Page, meta) => {
    render(<Page />);
    const { title } = DOCS_PAGES.find((p) => p.href === href)!;
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(title);
    expect(meta.title).toBe(title);
    expect(meta.description).toBeTruthy();

    const tabs = within(screen.getByRole("navigation", { name: "Docs" })).getAllByRole("link");
    expect(tabs.map((a) => [a.textContent, a.getAttribute("href")])).toEqual(
      DOCS_PAGES.map((p) => [p.title, p.href]),
    );
    expect(tabs.filter((a) => a.getAttribute("aria-current") === "page")).toEqual([
      tabs.find((a) => a.getAttribute("href") === href),
    ]);
    expect(footerLinks()).toEqual(FOOTER);
    // The footer follows the page's content, outside it.
    const main = screen.getByRole("main");
    expect(main.querySelector("footer")).toBeNull();
    expect(main.nextElementSibling?.tagName).toBe("FOOTER");
  });

  it.each(PAGES)("%s: every section is a level-2 heading naming its region", (_, Page) => {
    render(<Page />);
    const sections = [...document.querySelectorAll("section")];
    expect(sections.length).toBeGreaterThan(1);
    for (const section of sections) {
      const heading = section.querySelector("h2");
      expect(heading?.id).toBeTruthy();
      expect(section.getAttribute("aria-labelledby")).toBe(heading?.id);
    }
  });

  it("links from the landing page's footer", () => {
    render(<Landing signIn={{ available: false }} />);
    expect(footerLinks()).toEqual(FOOTER);
  });
});

describe("the Limits page states each limit as the code sets it", () => {
  const extract = DEFAULT_EXTRACT_LIMITS;
  const cases: [string, string][] = [
    ["source files", `${SUPPORTED_SOURCE_FILES.toLocaleString("en-US")} source files`],
    [
      "the analyzer's file limit",
      `${DEFAULT_LIMITS.maxSourceFiles.toLocaleString("en-US")} source files`,
    ],
    ["source size", `${String(SUPPORTED_SOURCE_MB)} MB of source code`],
    [
      "the analyzer's source size",
      `${String(DEFAULT_LIMITS.maxSourceBytes / MIB)} MB of source code`,
    ],
    ["what counts as source", [...SOURCE_EXTENSIONS].sort(byListedOrder).join(" ")],
    ["the file size skipped", `file over ${String(DEFAULT_LIMITS.maxFileBytes / MIB)} MB`],
    ["the folder depth", `nested more than ${String(DEFAULT_LIMITS.maxDepth)} deep`],
    ["GitHub's code count", `over ${String(MAX_GITHUB_CODE_BYTES / MIB)} MB of TypeScript`],
    ["the unpacked size", `up to ${String(extract.maxBytes / MIB)} MB`],
    ["the archive's entries", `${extract.maxEntries.toLocaleString("en-US")} files and folders`],
    ["the time limit", `at least ${ANALYSIS_TIME_LIMIT}`],
    ["the heap", `${DEFAULT_RUNNER_LIMITS.maxHeapMb.toLocaleString("en-US")} MB of memory`],
    ["the hold after a limit", `for ${String(SIZE_HOLD_DAYS)} days`],
    ["signed out", `${String(SIGNED_OUT_HOURLY_LIMIT)} new analyses an hour`],
    ["signed in", `${String(SIGNED_IN_HOURLY_LIMIT)} an hour`],
    ["per repo", `1 new analysis every ${String(REPO_ANALYSIS_MINUTES)} minutes`],
    ["views", `${String(RECHECKS_PER_HOUR)} new commits an hour`],
    ["the bot check, one address", `the ${ordinal(CHALLENGE_AFTER_PER_ADDRESS + 1)} new analysis`],
    ["the bot check, site-wide", `After ${String(CHALLENGE_AFTER_SITE)} requests`],
    ["the compute pause", `once ${String(Math.round(COMPUTE_PAUSE_RATIO * 100))}% of the month`],
    ["kept per repo", `its latest ${String(RETENTION_POLICY.keepPerRepo)} analyzed commits`],
    ["pull request pins", `in the last ${String(PR_PIN_DAYS)} days`],
    ["the storage budget", `past ${String(RETENTION_POLICY.budgetBytes / 1e9)} GB`],
  ];

  it.each(cases)("%s", (_, phrase) => {
    render(<Limits />);
    expect(text()).toContain(plain(phrase));
  });
});

describe("the Privacy page", () => {
  /** The cookie list's entries, as [name, how long it's kept]. */
  function cookieRows(): [string, string][] {
    const list = document.querySelector('dl[aria-label="Cookies"]');
    return [...(list?.querySelectorAll(".docs__term") ?? [])].map((term) => [
      term.querySelector("dt")?.textContent ?? "",
      term.querySelector(".docs__kept")?.textContent ?? "",
    ]);
  }

  it("lists every cookie the site sets, each kept as long as the code keeps it", () => {
    render(<Privacy />);
    const year = /Max-Age=(\d+)/.exec(themeCookie("dark", true))?.[1];
    expect(Number(year)).toBe(365 * 24 * 60 * 60);
    expect(cookieRows()).toEqual([
      [THEME_COOKIE, "Kept for 1 year."],
      [SESSION_COOKIE, `Kept for up to ${String(SESSION_LIFETIME_SECONDS / 86_400)} days.`],
      [STATE_COOKIE, `Kept for ${String(STATE_LIFETIME_SECONDS / 60)} minutes.`],
    ]);
  });

  it("checks private access as often as the access cache does", () => {
    render(<Privacy />);
    expect(text()).toContain(`at least every ${String(ACCESS_TTL_SECONDS)} seconds`);
  });

  it("links the security policy, where vulnerabilities are reported (M9.4b)", () => {
    render(<Privacy />);
    const link = screen.getByRole("link", { name: "security policy" });
    expect(link.getAttribute("href")).toBe(repoFile("SECURITY.md"));
  });
});

/** English ordinals: "1st", "2nd", "3rd", "4th", "11th", "21st". */
function ordinal(n: number): string {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10];
  return `${String(n)}${suffix ?? "th"}`;
}

/** The page lists TypeScript's extensions first, then JavaScript's, then Prisma. */
const LISTED = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".prisma"];
function byListedOrder(a: string, b: string): number {
  const rank = (ext: string) => (LISTED.includes(ext) ? LISTED.indexOf(ext) : LISTED.length);
  return rank(a) - rank(b);
}
