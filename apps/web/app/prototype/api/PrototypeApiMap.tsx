"use client";

import {
  Button,
  DEFAULT_STATE,
  EmptyState,
  encodeState,
  githubLineUrl,
  TopBar,
  UiIcon,
} from "@gitinside/viewer";
import {
  Fragment,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  apiMap,
  apiQueryString,
  callersText,
  filterApiMap,
  type ApiCall,
  type ApiQuery,
  type ApiRoute,
  type ApiTab,
} from "../../../lib/prototypeApiMap";
import {
  PROTOTYPE_HOME,
  prototypeApiHref,
  prototypeHref,
  type PrototypeRepo,
} from "../../../lib/prototypeLinks";
import { loadGraph, type GraphLoad } from "../../../lib/repoStatus";
import { PrototypeViews } from "../PrototypeViews";

/** Props for {@link PrototypeApiMap}. */
export interface PrototypeApiMapProps {
  repo: PrototypeRepo;
  /** `/api/prototype/graph/…` of the repo. */
  graphUrl: string;
  /** What the URL asked for (`?tab=&q=&service=&method=`). */
  initial: ApiQuery;
  /** The page's own items at the end of the bar (theme switch, sign-in). */
  barEnd?: ReactNode;
}

/** The tabs, in order, with their names. */
const TABS: readonly (readonly [ApiTab, string])[] = [
  ["all", "All"],
  ["dead", "No caller"],
  ["broken", "Broken calls"],
];

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** The analyzer's reason as a sentence: its words, capitalized. */
const sentence = (text: string | undefined) =>
  text === undefined ? "" : text.charAt(0).toUpperCase() + text.slice(1);

/**
 * The M10 prototype's API map page (M10-design §3.3, M10.3f3): every route in the repo's stored
 * graph with the requests that reach it, routes no request in the repo reaches, and requests that
 * reach no route, under the prototype's one bar with its `Diagram | API map` switch. The tab,
 * search, and filters are in the URL; a row opens to its callers, and "Diagram ↗" opens the
 * prototype's diagram with the route selected.
 */
export function PrototypeApiMap({ repo, graphUrl, initial, barEnd }: PrototypeApiMapProps) {
  const [load, setLoad] = useState<GraphLoad>();
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState(initial);

  useEffect(() => {
    const controller = new AbortController();
    setLoad(undefined);
    loadGraph(graphUrl, { signal: controller.signal }).then(setLoad, () => {
      // aborted: the page moved on
    });
    return () => controller.abort();
  }, [graphUrl, attempt]);

  // The URL follows the page, so a filtered view can be linked.
  useEffect(() => {
    const page = prototypeApiHref(repo, apiQueryString(query)) + window.location.hash;
    window.history.replaceState(window.history.state, "", page);
  }, [repo, query]);

  const map = useMemo(() => (load?.ok ? apiMap(load.graph) : undefined), [load]);
  const view = useMemo(() => map && filterApiMap(map, query), [map, query]);
  const set = (change: Partial<ApiQuery>) => setQuery((q) => ({ ...q, ...change }));

  const search = (
    <label className="api-search">
      <UiIcon name="search" />
      <input
        type="search"
        className="api-search__input"
        placeholder="Filter routes"
        aria-label="Filter routes"
        value={query.q}
        onChange={(e) => set({ q: e.target.value })}
      />
    </label>
  );

  return (
    // `data-own-header`: the bar below is the page's one bar (globals.css, M10-design A7).
    <main className="api-page" data-own-header="">
      <h1 className="visually-hidden">
        API map: {repo.owner} / {repo.name}
      </h1>
      <TopBar
        repo={repo}
        actions={false}
        variant="page"
        home={PROTOTYPE_HOME}
        status={{ state: "current", text: `Commit ${repo.sha}, pinned for the design review` }}
        views={<PrototypeViews repo={repo} current="api" />}
        end={
          <>
            {search}
            <CopyLink />
            {barEnd}
          </>
        }
      />
      <div className="api-page__body">
        {load !== undefined && !load.ok ? (
          <div className="api-page__state">
            <EmptyState
              title={load.title}
              tone="error"
              role="alert"
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
        ) : (
          <ApiBody repo={repo} map={map} view={view} query={query} set={set} />
        )}
      </div>
    </main>
  );
}

/** Share for a page with nothing to export: copies its link (the URL holds its filters). */
function CopyLink() {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <>
      <Button
        variant="quiet"
        icon="share"
        onClick={() => {
          navigator.clipboard?.writeText(window.location.href).then(
            () => setCopied(true),
            () => {
              // no clipboard: the address bar still has the link
            },
          );
        }}
      >
        {copied ? "Link copied" : "Share"}
      </Button>
      <span className="visually-hidden" role="status">
        {copied ? "Link copied" : ""}
      </span>
    </>
  );
}

interface BodyProps {
  repo: PrototypeRepo;
  map: ReturnType<typeof apiMap> | undefined;
  view: ReturnType<typeof filterApiMap> | undefined;
  query: ApiQuery;
  set: (change: Partial<ApiQuery>) => void;
}

/** The summary, the tabs and filters, and the tab's table (its head alone while the graph loads). */
function ApiBody({ repo, map, view, query, set }: BodyProps) {
  const id = useId();
  const tabs = useRef<HTMLDivElement>(null);
  const counts: Record<ApiTab, number | undefined> = {
    all: view?.all.length,
    dead: view?.dead.length,
    broken: view?.broken.length,
  };
  const move = (event: KeyboardEvent, index: number) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const next = TABS[(index + step + TABS.length) % TABS.length];
    if (!next) return;
    set({ tab: next[0] });
    tabs.current?.querySelector<HTMLElement>(`[data-tab="${next[0]}"]`)?.focus();
  };

  return (
    <>
      <p className="api-page__summary">
        {map
          ? [
              plural(map.routes.length, "route"),
              `${map.routes.filter((r) => r.callers.length === 0).length.toLocaleString("en-US")} with no caller in the repo`,
              plural(map.broken.length, "broken call"),
            ].join(" · ")
          : " "}
      </p>
      <div className="api-page__controls">
        <div className="api-tabs" role="tablist" aria-label="Routes" ref={tabs}>
          {TABS.map(([tab, label], i) => (
            <button
              key={tab}
              type="button"
              role="tab"
              id={`${id}-${tab}`}
              data-tab={tab}
              aria-selected={query.tab === tab}
              aria-controls={`${id}-panel`}
              tabIndex={query.tab === tab ? 0 : -1}
              className="api-tabs__tab"
              onClick={() => set({ tab })}
              onKeyDown={(e) => move(e, i)}
            >
              {label}
              {counts[tab] !== undefined && <span className="api-tabs__count">{counts[tab]}</span>}
            </button>
          ))}
        </div>
        <div className="api-page__filters">
          <Select
            label="Service"
            value={query.service}
            all="All services"
            options={map?.services ?? []}
            onChange={(service) => set({ service })}
          />
          <Select
            label="Method"
            value={query.method}
            all="All methods"
            options={(map?.methods ?? []).map((m) => [m, m] as const)}
            onChange={(method) => set({ method })}
          />
        </div>
      </div>
      <div
        role="tabpanel"
        id={`${id}-panel`}
        aria-labelledby={`${id}-${query.tab}`}
        className="api-page__panel"
      >
        {query.tab === "broken" ? (
          <CallsTab view={view} repo={repo} />
        ) : (
          <RoutesTable
            routes={view?.[query.tab]}
            repo={repo}
            empty={
              query.tab === "dead"
                ? "Every route here has a caller in the repo."
                : "No routes match."
            }
          />
        )}
      </div>
      {query.tab !== "broken" && (
        <p className="api-page__note">
          “No caller in the repo” means no request in this repo reaches it; outside clients (mobile
          apps, other repos, curl) aren’t visible to GitInside.
        </p>
      )}
    </>
  );
}

/** A filter as a native select, its "every value" option first. */
function Select({
  label,
  value,
  all,
  options,
  onChange,
}: {
  label: string;
  value: string;
  all: string;
  options: readonly (readonly [string, string])[];
  onChange: (value: string) => void;
}) {
  // A value the map doesn't have (an old link) still shows, so the page says what it filters by.
  const known = value === "" || options.some(([v]) => v === value);
  return (
    <label className="api-select">
      <span className="api-select__label">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{all}</option>
        {!known && <option value={value}>{value}</option>}
        {options.map(([v, name]) => (
          <option key={v} value={v}>
            {name}
          </option>
        ))}
      </select>
    </label>
  );
}

/** While the graph loads: the moving 2px line under a table's head (text under reduced motion). */
function Loading({ columns }: { columns: number }) {
  return (
    <tbody>
      <tr className="api-table__loading">
        <td colSpan={columns}>
          <span className="api-table__line" aria-hidden />
          <span className="api-table__loading-text" role="status">
            Loading the routes
          </span>
        </td>
      </tr>
    </tbody>
  );
}

/** A file:line link to the analyzed commit on GitHub. */
function SiteLink({ repo, file, line }: { repo: PrototypeRepo; file: string; line: number }) {
  const href = githubLineUrl(repo, file, line);
  // A long path wraps after a `/`, never inside a name.
  const parts = `${file}:${line}`.split("/");
  const text = parts.map((part, i) => (
    <Fragment key={i}>
      {part}
      {i < parts.length - 1 && (
        <>
          /<wbr />
        </>
      )}
    </Fragment>
  ));
  return href ? (
    <a className="api-site" href={href} target="_blank" rel="noreferrer">
      {text}
    </a>
  ) : (
    <code className="api-site">{text}</code>
  );
}

/** The routes table: method, path, service, callers, and a link into the diagram. */
function RoutesTable({
  routes,
  repo,
  empty,
}: {
  routes: readonly ApiRoute[] | undefined;
  repo: PrototypeRepo;
  empty: string;
}) {
  const prefix = useId();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((was) => {
      const next = new Set(was);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  return (
    <table className="api-table">
      <thead>
        <tr>
          <th scope="col">Method</th>
          <th scope="col">Path</th>
          <th scope="col">Service</th>
          <th scope="col">Callers</th>
          <th scope="col">
            <span className="visually-hidden">Diagram</span>
          </th>
        </tr>
      </thead>
      {routes === undefined ? (
        <Loading columns={5} />
      ) : routes.length === 0 ? (
        <tbody>
          <tr>
            <td colSpan={5} className="api-table__empty">
              {empty}
            </td>
          </tr>
        </tbody>
      ) : (
        routes.map((route, i) => {
          const isOpen = open.has(route.id);
          // Route IDs hold spaces, which `aria-controls` would split on.
          const callersId = `${prefix}-callers-${i}`;
          const name = `${route.method} ${route.path}`;
          return (
            <tbody key={route.id} className="api-row" data-open={isOpen ? "" : undefined}>
              <tr>
                <td>
                  <span className="api-method">{route.method}</span>
                </td>
                <td className="api-row__path">
                  {route.callers.length > 0 ? (
                    <button
                      type="button"
                      className="api-row__toggle"
                      aria-expanded={isOpen}
                      aria-controls={callersId}
                      onClick={() => toggle(route.id)}
                    >
                      <UiIcon name="chevron-right" size={14} />
                      <code>{route.path}</code>
                    </button>
                  ) : (
                    <code className="api-row__plain">{route.path}</code>
                  )}
                </td>
                <td className="api-row__service">{route.service}</td>
                <td
                  className="api-row__callers"
                  data-none={route.callers.length === 0 ? "" : undefined}
                >
                  {callersText(route.callers)}
                </td>
                <td className="api-row__link">
                  <a
                    href={prototypeHref(
                      repo,
                      encodeState({ ...DEFAULT_STATE, selected: route.id }),
                    )}
                    aria-label={`Open ${name} in the diagram`}
                  >
                    Diagram ↗
                  </a>
                </td>
              </tr>
              {isOpen && (
                <tr className="api-row__detail">
                  <td colSpan={5}>
                    <ul id={callersId} className="api-callers" aria-label={`Callers of ${name}`}>
                      {route.callers.map((c) => (
                        <li key={`${c.file}:${c.line}:${c.column}`}>
                          <SiteLink repo={repo} file={c.file} line={c.line} />
                          <span className="api-callers__name">{c.name}</span>
                          {c.service !== route.service && (
                            <span className="api-callers__service">{c.service}</span>
                          )}
                          <span className="api-confidence" data-confidence={c.confidence}>
                            {c.confidence}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </td>
                </tr>
              )}
            </tbody>
          );
        })
      )}
    </table>
  );
}

/** The Broken calls tab: requests for routes the repo doesn't have, then the ones it couldn't read. */
function CallsTab({
  view,
  repo,
}: {
  view: ReturnType<typeof filterApiMap> | undefined;
  repo: PrototypeRepo;
}) {
  const [showUnread, setShowUnread] = useState(false);
  const unread = view?.unread ?? [];
  return (
    <>
      <CallsTable
        calls={view?.broken}
        repo={repo}
        empty="No request in the repo asks for a route it doesn't have."
      />
      {unread.length > 0 && (
        <div className="api-unread">
          <p className="api-page__note">
            Not counted as broken: {plural(unread.length, "request")} whose URL GitInside couldn’t
            read, so it can’t say which route {unread.length === 1 ? "it reaches" : "they reach"}.
          </p>
          <Button
            variant="quiet"
            size="sm"
            aria-expanded={showUnread}
            onClick={() => setShowUnread((s) => !s)}
          >
            {showUnread ? "Hide them" : "Show them"}
          </Button>
          {showUnread && <CallsTable calls={unread} repo={repo} empty="" label="Unread requests" />}
        </div>
      )}
    </>
  );
}

/** Requests as the analyzer read them: method, URL, service, where, and why they matched nothing. */
function CallsTable({
  calls,
  repo,
  empty,
  label,
}: {
  calls: readonly ApiCall[] | undefined;
  repo: PrototypeRepo;
  empty: string;
  label?: string;
}) {
  return (
    <table className="api-table api-table--calls" aria-label={label}>
      <thead>
        <tr>
          <th scope="col">Method</th>
          <th scope="col">Request</th>
          <th scope="col">Service</th>
          <th scope="col">Where</th>
          <th scope="col">Why it matched no route</th>
        </tr>
      </thead>
      {calls === undefined ? (
        <Loading columns={5} />
      ) : (
        <tbody>
          {calls.length === 0 ? (
            <tr>
              <td colSpan={5} className="api-table__empty">
                {empty}
              </td>
            </tr>
          ) : (
            calls.map((c) => (
              <tr key={c.id} className="api-call">
                <td>
                  <span className="api-method">{c.method}</span>
                </td>
                <td className="api-call__url">
                  <code>{c.url}</code>
                </td>
                <td className="api-row__service">{c.service}</td>
                <td>
                  <SiteLink repo={repo} file={c.file} line={c.line} />
                </td>
                <td className="api-call__why">{sentence(c.detail)}</td>
              </tr>
            ))
          )}
        </tbody>
      )}
    </table>
  );
}
