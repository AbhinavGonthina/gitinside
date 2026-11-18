/** An API-named env var whose fallback carries the path prefix every route has. */
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";

/** A name that doesn't look like an API base, but the fallback is this machine. */
export const SERVER = process.env.REACT_APP_SERVER || "http://localhost:4000";

/** A literal fallback in the middle of the URL. */
export const VERSION = process.env.REACT_APP_API_VERSION || "v2";

/** A fallback that is a remote host: the name still isn't API-like, so no guess. */
export const STATS = process.env.STATS_HOST ?? "https://stats.example.com/api/v1";

/** A name that isn't API-like, but the fallback is a root-relative path: the page's own origin. */
export const AUTH_BASE = import.meta.env.VITE_AUTH_BASE || "/auth";

/** A page-relative fallback: the page's folder is unknown, so no guess. */
export const PAGES = process.env.REACT_APP_PAGES || "auth";

/** A root-relative fallback with a value only known at runtime in its path: no guess. */
export const TENANT = process.env.REACT_APP_TENANT || "/tenants/" + localStorage.getItem("tenant");
