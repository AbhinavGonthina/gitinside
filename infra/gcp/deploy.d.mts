/** Types for `deploy.mjs` (a plain Node script, so CI runs it without a build). */

export interface DeployTarget {
  project: string;
  region: string;
  account: string;
  image: string;
  pool: string;
  provider: string;
}

export interface Queue {
  name: string;
  rateLimits: { maxDispatchesPerSecond: number; maxConcurrentDispatches: number };
  retryConfig: {
    maxAttempts: number;
    maxRetryDuration: string;
    minBackoff: string;
    maxBackoff: string;
    maxDoublings: number;
  };
  stackdriverLoggingConfig: { samplingRatio: number };
}

export function deployTarget(): DeployTarget;
export function plan(projectNumber: string | undefined): { provider: string; account: string };
export function imageInputs(): string[];
export function touchesImage(paths: string[], inputs?: string[]): boolean;
export function needsDeploy(
  before: string | undefined,
  after: string,
  git?: (args: string[]) => string,
): boolean;
export function render(text: string, values: Record<string, string>, target?: DeployTarget): string;
export function queueUpdateArgs(queue: Queue, project: string): string[];
export const VARIABLES: string[];
export function apply(options: {
  sha: string;
  env: Record<string, string | undefined>;
  exec: (command: string, args: string[]) => string;
  out: string;
}): string;
