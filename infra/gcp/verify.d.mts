/** Types for `verify.mjs` (a plain Node script, so it runs from a checkout without a build). */

export const FREE_REGISTRY_BYTES: number;
export function googleBase(host: string): string;

export class GoogleError extends Error {
  constructor(host: string, status: number, reason: string, message: string);
  host: string;
  status: number;
  reason: string;
}

export function seconds(duration: unknown): number | undefined;
export function millicores(quantity: unknown): number | undefined;
export function bytes(quantity: unknown): number | undefined;
export function cleanupPolicyKey(policy: object): string;

export interface VerifyOptions {
  fetch?: typeof globalThis.fetch;
  base?: (host: string) => string;
}

export function verifyGuardrails(
  options: VerifyOptions & { token: string },
): Promise<{ checks: number; problems: string[] }>;
export function gcloudToken(): string;
export function main(
  options?: VerifyOptions & { token?: () => string; log?: (line: string) => void },
): Promise<number>;
