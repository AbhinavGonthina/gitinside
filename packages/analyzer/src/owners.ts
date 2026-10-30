/**
 * Who a call belongs to, as a per-service fact (M6.7d2, ADR-0094). The Prisma, HTTP, SDK, and
 * queue detectors draw an edge from the code a call sits in: the innermost symbol node, or the
 * routes of an inline Express handler (`app.get("/u", (req, res) => …)`) around it. Which
 * function expressions are inline handlers is only known once Express is composed over every
 * service (a router's routes come from the files that mount it), so a detector's walk records
 * the candidates as node keys ({@link Owners}) and {@link bindOwners} turns them into IDs after
 * the composition. The walk itself never needs another service's analysis.
 */
import ts from "typescript";
import { nodeKey } from "./calls.js";

/** The owners of a call before Express composition. Plain data (JSON round-trips). */
export interface Owners {
  /**
   * Node keys (see `nodeKey`) of the arrow and function expressions around the call, innermost
   * first, up to and including the one at the nearest symbol: the inline handlers it may be in.
   */
  handlers: string[];
  /**
   * The owner IDs when none of `handlers` is an inline handler: the nearest symbol's node ID,
   * a detector's fallback (such as the file node), or none for top-level code.
   */
  ids: string[];
}

/** The owners of top-level code: none. */
export const NO_OWNERS: Owners = { handlers: [], ids: [] };

/** The node key of `node`, a node of root file `file`, if it could be an inline handler. */
export function handlerKey(file: string, node: ts.Node): string | undefined {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node)
    ? nodeKey(file, node)
    : undefined;
}

/**
 * The owners of code inside `node`, a node of root file `file`, given the owners around it
 * and the symbol node ID `node` declares, if any. An inline handler takes precedence over the
 * symbol at the same node, and a symbol hides every handler around it.
 */
export function ownersAt(
  file: string,
  node: ts.Node,
  symbol: string | undefined,
  outer: Owners,
): Owners {
  const handler = handlerKey(file, node);
  if (symbol !== undefined)
    return { handlers: handler === undefined ? [] : [handler], ids: [symbol] };
  if (handler === undefined) return outer;
  return { handlers: [handler, ...outer.handlers], ids: outer.ids };
}

/**
 * `owners` with `ids` used when it would otherwise bind to none (top-level code outside any
 * inline handler), such as a detector's file node. Bound routes are never empty, so this
 * equals falling back after binding.
 */
export function withFallback(owners: Owners, ids: readonly string[]): Owners {
  return owners.ids.length > 0 ? owners : { handlers: owners.handlers, ids: [...ids] };
}

/**
 * The owner IDs of {@link Owners}: the routes of the innermost of its `handlers` that is an
 * inline handler in `inlineHandlers` (Express's, sorted), else its `ids`. A new array.
 */
export function bindOwners(
  owners: Owners,
  inlineHandlers: ReadonlyMap<string, readonly string[]>,
): string[] {
  for (const key of owners.handlers) {
    const routes = inlineHandlers.get(key);
    if (routes) return [...routes];
  }
  return [...owners.ids];
}
