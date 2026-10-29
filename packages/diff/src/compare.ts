import type { ArchitectureGraph, GraphRepo } from "@gitinside/schema";

/** Thrown when two graphs can't be diffed meaningfully. The message says what to do instead. */
export class IncompatibleGraphsError extends Error {
  override readonly name = "IncompatibleGraphsError";
}

/** `owner/name@sha` for messages; the SHA is left out when the graph has none. */
export function describeRepo(repo: GraphRepo): string {
  return `${repo.owner}/${repo.name}${repo.sha === undefined ? "" : `@${repo.sha}`}`;
}

/**
 * Refuse a pair of graphs whose differences would come from the analyzer rather than
 * the code: graphs from two analyzer versions differ wherever the analyzer changed,
 * and every such difference would read as a change in the PR. The schema version
 * needs no check here, because `parseGraph` only accepts the current one.
 *
 * The repos aren't compared: a fork's PR head is analyzed under the fork's name, and
 * the CLI diffs local folders whose names are whatever the caller passed.
 */
export function checkComparable(base: ArchitectureGraph, head: ArchitectureGraph): void {
  if (base.analyzerVersion !== head.analyzerVersion) {
    throw new IncompatibleGraphsError(
      `${describeRepo(base.repo)} was analyzed with analyzer ${base.analyzerVersion} and ` +
        `${describeRepo(head.repo)} with ${head.analyzerVersion}; analyze both with the same version`,
    );
  }
}
