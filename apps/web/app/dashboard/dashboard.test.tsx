import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthDeps, SignedInUser } from "../../lib/authRoute";
import type { DashboardView } from "../../lib/dashboard";
import type { Installation } from "../../lib/installations";
import { Dashboard } from "./Dashboard";

const state: {
  current: { auth?: AuthDeps; user?: SignedInUser };
  view: DashboardView;
} = { current: {}, view: { kind: "ready", installations: [], total: 0 } };

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT ${url}`);
  },
}));
vi.mock("../../lib/currentUser", () => ({ currentUser: async () => state.current }));
vi.mock("../../lib/dashboard", async (actual) => ({
  ...(await actual<typeof import("../../lib/dashboard")>()),
  loadDashboard: async () => state.view,
}));

const { default: DashboardPage, metadata } = await import("./page");

afterEach(cleanup);
beforeEach(() => {
  state.current = {};
  state.view = { kind: "ready", installations: [], total: 0 };
});

const INSTALL_URL = "https://github.com/apps/gitinside/installations/new";
const ACME: Installation = {
  id: 41,
  account: "acme",
  accountType: "Organization",
  selection: "selected",
  repos: [
    { owner: "acme", name: "api", private: false },
    { owner: "acme", name: "web", private: true },
  ],
  totalRepos: 2,
};
const OCTO: Installation = {
  id: 7,
  account: "octo",
  accountType: "User",
  selection: "all",
  repos: [],
  totalRepos: 0,
};

describe("dashboard page", () => {
  const signedIn = () => {
    state.current = { auth: {} as AuthDeps, user: { login: "octo" } as SignedInUser };
  };

  it("says sign-in is unavailable while it isn't set up", async () => {
    await expect(DashboardPage()).rejects.toThrow("REDIRECT /?signin=unavailable");
  });

  it("starts sign-in, coming back here, while signed out", async () => {
    state.current = { auth: {} as AuthDeps };
    await expect(DashboardPage()).rejects.toThrow(
      "REDIRECT /api/auth/github?returnTo=%2Fdashboard",
    );
  });

  it("lands signed out with a note when the session's GitHub sign-in has ended", async () => {
    signedIn();
    state.view = { kind: "ended" };
    await expect(DashboardPage()).rejects.toThrow("REDIRECT /?signin=ended");
  });

  it("renders the view for a signed-in user, kept out of search results", async () => {
    signedIn();
    state.view = { kind: "ready", installations: [ACME], total: 1, installUrl: INSTALL_URL };
    render(await DashboardPage());
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Your repos");
    expect(screen.getByRole("link", { name: /api/ }).getAttribute("href")).toBe("/acme/api");
    expect(metadata).toEqual({ title: "Your repos", robots: { index: false, follow: false } });
  });
});

describe("Dashboard", () => {
  it("lists each installation's repos, linking to their diagrams, private ones marked", () => {
    render(
      <Dashboard
        view={{ kind: "ready", installations: [ACME, OCTO], total: 2, installUrl: INSTALL_URL }}
      />,
    );
    const acme = screen.getByRole("region", { name: "acme" });
    expect(within(acme).getByText("Organization · 2 repos selected")).toBeTruthy();
    const links = within(acme).getAllByRole("link");
    expect(links.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["Choose repos", "https://github.com/organizations/acme/settings/installations/41"],
      ["acme/api", "/acme/api"],
      ["acme/webPrivate", "/acme/web"],
    ]);

    const octo = screen.getByRole("region", { name: "octo" });
    expect(within(octo).getByText("Personal account · All repos")).toBeTruthy();
    expect(within(octo).getByText("No repos on this account yet.")).toBeTruthy();
    expect(within(acme).queryByText(/^No repos/)).toBeNull();

    expect(screen.getByRole("link", { name: "Install on more repos" }).getAttribute("href")).toBe(
      INSTALL_URL,
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says how many repos and installations aren't listed", () => {
    render(
      <Dashboard
        view={{
          kind: "ready",
          installations: [{ ...ACME, totalRepos: 302 }],
          total: 120,
        }}
      />,
    );
    expect(screen.getByText(/^300 more repos aren't listed here\./)).toBeTruthy();
    expect(screen.getByRole("link", { name: "See them on GitHub" }).getAttribute("href")).toBe(
      "https://github.com/organizations/acme/settings/installations/41",
    );
    expect(screen.getByText("Showing 1 of 120 installations.")).toBeTruthy();
    // No slug, no install link.
    expect(screen.queryByRole("link", { name: "Install on more repos" })).toBeNull();
  });

  it("says an installation on chosen repos has none chosen", () => {
    render(
      <Dashboard
        view={{
          kind: "ready",
          installations: [{ ...ACME, repos: [], totalRepos: 0 }],
          total: 1,
        }}
      />,
    );
    expect(screen.getByText("No repos selected on this account.")).toBeTruthy();
  });

  it("explains installing when there's nothing installed", () => {
    const { unmount } = render(
      <Dashboard view={{ kind: "ready", installations: [], total: 0, installUrl: INSTALL_URL }} />,
    );
    expect(
      screen.getByRole("heading", { name: "GitInside isn't installed on your repos yet" }),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Install GitInside" }).getAttribute("href")).toBe(
      INSTALL_URL,
    );
    // One call to action, not two.
    expect(screen.queryByRole("link", { name: "Install on more repos" })).toBeNull();
    unmount();

    render(<Dashboard view={{ kind: "ready", installations: [], total: 0 }} />);
    expect(screen.getByText("Installing isn't available right now.")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Install GitInside" })).toBeNull();
  });

  it("says GitHub couldn't be read, with Try again", () => {
    render(<Dashboard view={{ kind: "error", installUrl: INSTALL_URL }} />);
    const alert = screen.getByRole("alert");
    expect(within(alert).getByRole("heading").textContent).toBe("Your repos didn't load");
    expect(within(alert).getByRole("link", { name: "Try again" }).getAttribute("href")).toBe(
      "/dashboard",
    );
    expect(screen.queryByRole("region")).toBeNull();
  });
});
