"use client";

import {
  browserOnboarding,
  buildDiffOverlay,
  buildHierarchy,
  Button,
  createGitHubSourceLoader,
  decodeState,
  EmptyState,
  encodeState,
  Explorer,
  IconButton,
  ShareMenu,
  UiIcon,
  withBase,
  withState,
  type DecodedState,
  type ExplorerState,
  type ViewExport,
} from "@gitinside/viewer";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  baseFailedNote,
  baseNote,
  compareGraphs,
  linkedVersion,
  type BaseView,
} from "../../../lib/compare";
import { ignoredNote, shareUrl } from "../../../lib/deepLink";
import { headStatus, loadGraph, short, type GraphLoad } from "../../../lib/repoStatus";
import type { HeadState } from "../../../lib/repoView";
import { AddToReadme } from "./AddToReadme";
import { githubHref } from "./RepoNotice";
import { useAnalyze } from "./useAnalyze";

/** Props for {@link RepoDiagram}: a `ready` view from `viewRepo`. */
export interface RepoDiagramProps {
  /** GitHub's spelling, from the database. */
  owner: string;
  repo: string;
  sha: string;
  /** `/api/graph/…` of this commit. */
  graphUrl: string;
  head: HeadState;
  /** The commit a link's `?base=` compares this one with (`viewBase`), if it names one. */
  base?: BaseView | undefined;
}

/**
 * Starts the diagram's layout worker (`layoutWorker.ts`). Module-level, so the explorer's
 * engine isn't rebuilt on every render; only ever called in the browser.
 */
const layoutWorker = () =>
  new Worker(new URL("./layoutWorker.ts", import.meta.url), {
    type: "module",
    name: "gitinside-layout",
  });

/** The first-visit hints, remembered in this browser's `localStorage` (M4b.12a). */
const onboarding = browserOnboarding();

/**
 * Set by Stop comparing (M6.11h): the next diagram drawn takes focus. Module-level, since
 * from the latest commit's page the permalink is another page, so another `RepoDiagram`.
 */
const stopping = { pending: false };

/**
 * The diagram page (ADR-0069): a repo bar (name, commit, how it relates to the latest
 * commit), then the diagram. The graph is fetched in the browser from `/api/graph`, so the
 * page itself stays small and the CDN caches the graph per commit. "Add to README" and the
 * share menu live on the repo bar, since the explorer's top bar is hidden. The diagram is the
 * M4b explorer without its top bar, laid out in a Web Worker (the explorer falls back to the
 * main thread if the worker can't start).
 *
 * Deep links (M4b.9b, ADR-0123): the explorer opens from the page's query (`decodeState`
 * against the loaded graph), and each change it reports replaces the query in place
 * (`history.replaceState`, no new history entry). What part of a link this commit doesn't
 * have is named in a note above the diagram (read out through a live region that's there
 * from the start; dismissing it moves focus into the diagram). Copy link gives the commit's permalink with
 * the state. Export (M4b.10b) saves the view the explorer has drawn (its `exportRef`) as
 * SVG, PNG, or Mermaid, made in the browser.
 *
 * Diff mode (M6.9e2, ADR-0189): with a `base` that has an analysis, both graphs load side by
 * side and are diffed in the browser (`compareGraphs`); the explorer then draws the overlay,
 * reading Base's code at the base commit. The link keeps `base` first (`withBase`), on the
 * address bar and in Copy link, and the explorer's Base / Head / Overlay (on its canvas, as
 * `view`). A base that can't be compared (not a full SHA, never analyzed, another analyzer
 * version) is said in the note, and the diagram is this commit alone. The repo bar names the
 * base commit (linked to GitHub) once it's compared, and with any `base` offers Stop
 * comparing: this commit's permalink with the same state, after which focus goes to the
 * diagram (M6.11h). A linked Base or Head without the link's selection or trace start opens on
 * the Overlay, said in the note, and Copy link names the Overlay (`linkedVersion`).
 *
 * A graph of this commit that fails to load or parse (M4b.12b2) gets the explorer's empty-state
 * card in the error tone where the diagram goes: what happened, why or what to do, and Try
 * again only when another attempt could help. Focus moves to the card, so a keyboard or
 * screen-reader user lands on it. A base that fails leaves this commit's diagram on screen,
 * alone, with the reason in the note and, when it could help, a Try again for the base alone
 * (M6.11h).
 */
export function RepoDiagram({ owner, repo, sha, graphUrl, head, base }: RepoDiagramProps) {
  const [loads, setLoads] = useState<
    { head: GraphLoad; base?: GraphLoad; baseUrl: string | undefined } | undefined
  >();
  // Bumped by "Try again".
  const [attempt, setAttempt] = useState(0);
  const failure = useRef<HTMLDivElement>(null);
  // The view on screen, kept by the explorer, for the share menu's Export.
  const exportRef = useRef<ViewExport | undefined>(undefined);
  const status = headStatus(owner, repo, head);
  const { analyze, busy, error, asked, check } = useAnalyze(owner, repo);
  // Code previews read the public file at this commit straight from GitHub (ADR-0115).
  const loadSource = useMemo(
    () => createGitHubSourceLoader({ owner, name: repo, sha }),
    [owner, repo, sha],
  );
  // Diff mode (M6.9e2): the base commit's graph and code, when the link names one that loads.
  const baseUrl = base?.status === "ready" ? base.graphUrl : undefined;
  const baseSha = base?.status === "ready" ? base.sha : undefined;
  const loadBaseSource = useMemo(
    () =>
      baseSha === undefined
        ? undefined
        : createGitHubSourceLoader({ owner, name: repo, sha: baseSha }),
    [owner, repo, baseSha],
  );
  // A base that's a full SHA stays in the link, even one not analyzed yet: it compares once it is.
  const keptBase = base?.status === "ready" || base?.status === "missing" ? base.sha : undefined;
  // This commit's failed load goes on the card. The base's leaves this commit on screen, alone,
  // with a note and its own Try again (M6.11h).
  const load = loads?.head;
  const baseFailure = load?.ok && loads?.base?.ok === false ? loads.base : undefined;
  const [baseRetrying, setBaseRetrying] = useState(false);
  const baseRetry = useRef<AbortController>(undefined);
  const comparison = useMemo(
    () =>
      loads?.head.ok && loads.base?.ok
        ? compareGraphs(loads.base.graph, loads.head.graph)
        : undefined,
    [loads],
  );
  const compared = comparison?.ok ? comparison : undefined;

  // The page's link, read once per loaded graph (and again once a retried base compares): the
  // explorer's initial props take it. In diff mode it names the overlay's nodes (both versions,
  // on head's IDs), and a Base or Head without the link's selection or trace opens on the
  // Overlay, said in the note (`linkedVersion`), so Copy link names what's shown.
  const linked = useMemo<(DecodedState & { versionNote?: string }) | undefined>(() => {
    if (!load?.ok) return undefined;
    if (!compared) return decodeState(window.location.search, buildHierarchy(load.graph));
    const overlay = buildDiffOverlay(compared.base, load.graph, compared.diff);
    const decoded = decodeState(window.location.search, buildHierarchy(overlay.graph));
    const { state, note: versionNote } = linkedVersion(decoded.state, overlay.nodesIn);
    return versionNote === undefined ? decoded : { state, ignored: decoded.ignored, versionNote };
  }, [load, compared]);
  // The state since the explorer last reported, for Copy link and Stop comparing.
  const [reported, setReported] = useState<ExplorerState>();
  /**
   * A state as the link keeps it: Base or Head only with the base they're of. A base that
   * isn't analyzed yet keeps the link's view with it (the explorer, comparing nothing,
   * reports the Overlay), so the link opens on it once it compares.
   */
  const kept = (state: ExplorerState): ExplorerState => ({
    ...state,
    version: compared
      ? state.version
      : keptBase !== undefined
        ? (linked?.state.version ?? "overlay")
        : "overlay",
  });
  const shown = reported ?? linked?.state;
  const linkQuery = withBase(shown ? encodeState(kept(shown)) : "", keptBase);
  // Stop comparing (M6.9e2b): this commit's permalink with the same state, on its own graph
  // (no Base or Head there); what only the base had is then left out and said in the note.
  const alone = withState(
    `/${owner}/${repo}/${sha}`,
    shown ? encodeState({ ...shown, version: "overlay" }) : "",
  );
  const [dismissed, setDismissed] = useState<DecodedState>();
  const notes =
    linked && linked !== dismissed
      ? [
          base && baseNote(base, sha),
          baseFailure && baseSha !== undefined
            ? baseFailedNote(baseSha, baseFailure, sha)
            : undefined,
          comparison?.ok === false ? comparison.note : undefined,
          linked.versionNote,
          ignoredNote(linked.ignored, sha),
        ].filter((text) => text !== undefined)
      : [];
  const note = notes.length > 0 ? notes.join(" ") : undefined;
  const canvas = useRef<HTMLDivElement>(null);
  // Add to README and Share share a spot under the bar, so only one is open at a time.
  const [menu, setMenu] = useState<"readme" | "share">();
  const openMenu = (which: "readme" | "share", open: boolean) =>
    setMenu((current) => (open ? which : current === which ? undefined : current));

  /** Hides the note; its Dismiss had focus, so focus goes on to the diagram, next in the page. */
  const dismissNote = () => {
    const button = document.activeElement;
    setDismissed(linked);
    if (button instanceof HTMLElement && button.closest(".diagram-page__note"))
      canvas.current
        ?.querySelector<HTMLElement>("a[href], button:not(:disabled), input, [tabindex='0']")
        ?.focus();
  };

  const onStateChange = (state: ExplorerState) => {
    const next = encodeState(kept(state));
    setReported(state);
    const { pathname, hash } = window.location;
    const page = withState(pathname, withBase(next, keptBase));
    window.history.replaceState(window.history.state, "", page + hash);
  };

  /** The note's Try again: loads the base alone, leaving this commit's diagram on screen. */
  const retryBase = () => {
    if (baseUrl === undefined) return;
    baseRetry.current?.abort();
    const controller = new AbortController();
    baseRetry.current = controller;
    setBaseRetrying(true);
    loadGraph(baseUrl, { signal: controller.signal }).then(
      (baseLoad) => {
        setBaseRetrying(false);
        setLoads((current) => current && { ...current, base: baseLoad });
      },
      () => {
        // aborted: the page moved on
      },
    );
  };

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    setLoads(undefined);
    setReported(undefined);
    setBaseRetrying(false);
    // Side by side: the page waits for the slower one, not for both in turn.
    Promise.all([
      loadGraph(graphUrl, { signal }),
      baseUrl === undefined ? undefined : loadGraph(baseUrl, { signal }),
    ]).then(
      ([headLoad, baseLoad]) =>
        setLoads(
          baseLoad ? { head: headLoad, base: baseLoad, baseUrl } : { head: headLoad, baseUrl },
        ),
      () => {
        // aborted: the page moved on
      },
    );
    return () => {
      controller.abort();
      baseRetry.current?.abort();
    };
  }, [graphUrl, baseUrl, attempt]);

  useEffect(() => {
    if (load && !load.ok) failure.current?.focus();
  }, [load]);

  // The graphs on screen are of the base the page now names; false between a change of base and
  // the reload it starts (Stop comparing from a compared base).
  const fresh = loads === undefined || loads.baseUrl === baseUrl;

  // After Stop comparing (M6.11h): focus waits on the diagram's spot until this commit's diagram
  // is drawn alone, then goes to its focusable box, so it isn't left on `<body>` when the link
  // goes. Run when the base goes (a base never compared reloads nothing) and when the load does;
  // the diagram of the comparison being replaced is never the target. The spot is focusable only
  // meanwhile: otherwise a click on the empty canvas would take focus out of the explorer.
  useEffect(() => {
    const host = canvas.current;
    if (!stopping.pending || !host) return;
    if (fresh && load && !load.ok) {
      stopping.pending = false; // the error card takes focus
      host.removeAttribute("tabindex");
      return;
    }
    const land = () => {
      if (!fresh) return false;
      const box = host.querySelector<HTMLElement>(".gi-drill__node [tabindex='0']");
      if (!box) return false;
      stopping.pending = false;
      box.focus();
      host.removeAttribute("tabindex");
      return true;
    };
    if (land()) return;
    if (!host.contains(document.activeElement)) {
      host.tabIndex = -1;
      host.focus();
    }
    const observer = new MutationObserver(() => {
      if (land()) observer.disconnect();
    });
    observer.observe(host, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["tabindex"],
    });
    return () => observer.disconnect();
  }, [load, base, fresh]);

  return (
    <main className="diagram-page">
      <div className="repo-bar">
        <div className="repo-bar__title">
          <h1 className="repo-bar__name">
            <span className="notice__owner">{owner} /</span> {repo}
          </h1>
          <a
            className="gi-chip repo-bar__commit"
            href={githubHref(owner, repo, sha)}
            rel="noopener noreferrer"
            title={`Commit ${sha} on GitHub`}
          >
            <UiIcon name="commit" size={14} />
            <code>{short(sha)}</code>
          </a>
        </div>
        {base && (
          <p className="repo-bar__compare">
            {compared && baseSha !== undefined && (
              <>
                <span>compared with</span>
                <a
                  className="gi-chip repo-bar__commit"
                  href={githubHref(owner, repo, baseSha)}
                  rel="noopener noreferrer"
                  title={`Base commit ${baseSha} on GitHub`}
                >
                  <UiIcon name="commit" size={14} />
                  <code>{short(baseSha)}</code>
                </a>
              </>
            )}
            <Link
              href={alone}
              onClick={(event) => {
                // Only when this tab moves on, not for a new tab or window.
                const elsewhere = event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
                stopping.pending = event.button === 0 && !elsewhere;
              }}
            >
              Stop comparing
            </Link>
          </p>
        )}
        <p className="repo-bar__status" data-tone={status.tone}>
          <span>{status.text}</span>
          {status.link && <Link href={status.link.href}>{status.link.label}</Link>}
        </p>
        {status.analyze && (
          <Button variant="secondary" size="sm" onClick={analyze} aria-busy={busy || undefined}>
            Analyze again
          </Button>
        )}
        {error && (
          <p className="repo-bar__error" role="alert">
            {error}
          </p>
        )}
        {asked && (
          <p className="repo-bar__asked" role="status">
            {asked}
          </p>
        )}
        {check}
        <AddToReadme
          owner={owner}
          repo={repo}
          open={menu === "readme"}
          onOpenChange={(open) => openMenu("readme", open)}
        />
        <ShareMenu
          variant="secondary"
          size="sm"
          open={menu === "share"}
          onOpenChange={(open) => openMenu("share", open)}
          link={() => shareUrl(window.location.origin, owner, repo, sha, linkQuery)}
          exports={() => exportRef.current}
        />
        <a className="repo-bar__github" href={githubHref(owner, repo)} rel="noopener noreferrer">
          Open on GitHub
        </a>
      </div>
      {/* Mounted empty with the page, so the note arriving is a change a screen reader reads.
          It's the only copy screen readers get: the visible one is hidden from them, so browse
          mode doesn't read it twice (M4b.16). */}
      <p className="visually-hidden" aria-live="polite">
        {note ?? ""}
      </p>
      {note && (
        <div className="diagram-page__note">
          <p aria-hidden="true">{note}</p>
          {baseFailure?.retry && (
            <Button
              variant="secondary"
              size="sm"
              onClick={retryBase}
              aria-busy={baseRetrying || undefined}
            >
              Try again
            </Button>
          )}
          <IconButton icon="close" label="Dismiss" size="sm" onClick={dismissNote} />
        </div>
      )}
      <div className="diagram-page__canvas" ref={canvas}>
        {load === undefined ? (
          <p className="diagram-page__state" role="status">
            Loading the diagram
          </p>
        ) : load.ok ? (
          linked && (
            <Explorer
              // A base that arrives on Try again starts diff mode afresh, from the link.
              key={compared ? "compared" : "alone"}
              graph={load.graph}
              topBar={false}
              layoutWorker={layoutWorker}
              loadSource={loadSource}
              initialOpen={linked.state.open}
              initialSelected={linked.state.selected}
              initialTrace={linked.state.trace}
              initialStep={linked.state.step}
              initialFilters={linked.state.filters}
              initialHiddenKinds={linked.state.hiddenKinds}
              initialVersion={linked.state.version}
              onStateChange={onStateChange}
              exportRef={exportRef}
              onboarding={onboarding}
              diff={
                compared && { base: compared.base, diff: compared.diff, loadSource: loadBaseSource }
              }
            />
          )
        ) : (
          <div className="diagram-page__state">
            <EmptyState
              ref={failure}
              title={load.title}
              tone="error"
              role="alert"
              tabIndex={-1}
              actions={
                load.retry ? (
                  <Button variant="primary" onClick={() => setAttempt((n) => n + 1)}>
                    Try again
                  </Button>
                ) : undefined
              }
            >
              <p>{load.message}</p>
            </EmptyState>
          </div>
        )}
      </div>
    </main>
  );
}
