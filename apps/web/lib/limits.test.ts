import { DEFAULT_LIMITS, MAX_SOURCE_MB } from "@gitinside/analyzer";
import { DEFAULT_EXTRACT_LIMITS } from "@gitinside/worker/extract";
import { describe, expect, it } from "vitest";
import {
  NBSP,
  SUPPORTED_ENTRIES,
  SUPPORTED_SIZE,
  SUPPORTED_SOURCE_FILES,
  SUPPORTED_SOURCE_MB,
  SUPPORTED_UNPACKED_MB,
} from "./limits";

describe("supported size", () => {
  it("is the analyzer's own inventory limits", () => {
    expect(SUPPORTED_SOURCE_FILES).toBe(DEFAULT_LIMITS.maxSourceFiles);
    expect(SUPPORTED_SOURCE_MB).toBe(MAX_SOURCE_MB);
    expect(SUPPORTED_SOURCE_MB * 1024 * 1024).toBe(DEFAULT_LIMITS.maxSourceBytes);
  });

  it("is the worker's own extraction limits (ADR-0146)", () => {
    expect(SUPPORTED_UNPACKED_MB * 1024 * 1024).toBe(DEFAULT_EXTRACT_LIMITS.maxBytes);
    expect(SUPPORTED_ENTRIES).toBe(DEFAULT_EXTRACT_LIMITS.maxEntries);
  });

  it("says both numbers in words, never breaking between 50 and MB", () => {
    expect(NBSP.codePointAt(0)).toBe(0xa0);
    expect(SUPPORTED_SIZE).toBe(`up to 20,000 source files and 50${NBSP}MB of source code`);
  });
});
