// Runs in the layout worker before ELK's script (`worker.ts` imports it
// first; ES modules run in import order). Two things a host's bundler can
// break, found building the website's worker with Next.js (M4b.3b2):
//
// 1. Next.js folds `typeof window` to "object" in browser code, workers
//    included, so ELK's `if (typeof window !== 'undefined') $wnd = window`
//    reads a global a worker doesn't have and throws. Naming the worker's own
//    global `window` gives ELK what it would have picked anyway (`self`).
//    Checked with `in`, which no bundler folds.
// 2. A bundler's worker runtime can turn that load error into a rejected
//    promise inside the worker, which never reaches the page's `error`
//    listener, so the engine would wait for an answer forever. Rethrowing it
//    from a listener makes it an uncaught error, which the page does get, and
//    the engine falls back to the main thread.

const scope = globalThis as unknown as Record<string, unknown>;
if (!("window" in scope)) scope.window = globalThis;

globalThis.addEventListener("unhandledrejection", (event) => {
  throw event.reason;
});

export {};
