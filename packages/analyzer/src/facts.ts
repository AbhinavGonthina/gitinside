/**
 * One service's facts (ADR-0174): everything its analysis found, as plain data, before the
 * global steps compose the graph. `analyze` collects a {@link ServiceFacts} per service, stage
 * by stage, then composes each stage from every service's facts; M6.7e reuses a clean
 * service's bundle from the cache instead of collecting it.
 */
import type { AnalysisWarning, GraphNode } from "@gitinside/schema";
import type { CallFacts } from "./calls.js";
import type { ExpressFacts } from "./express.js";
import type { ImportFacts } from "./imports.js";
import type { NextFacts } from "./next.js";
import type { PrismaFacts } from "./prisma.js";
import type { QueueFacts } from "./queues.js";
import type { SdkFacts } from "./sdk.js";
import type { HttpFacts } from "./wrappers.js";

/** Each detector stage's per-service facts. */
export interface StageFacts {
  imports: ImportFacts;
  express: ExpressFacts;
  next: NextFacts;
  prisma: PrismaFacts;
  calls: CallFacts;
  http: HttpFacts;
  sdk: SdkFacts;
  queues: QueueFacts;
}

/** A detector stage that collects per-service facts. */
export type FactStage = keyof StageFacts;

/** A stage whose collection threw for a service, and the `DETECTOR_FAILED` warning it gives. */
export interface StageFailure {
  stage: FactStage;
  warning: AnalysisWarning;
}

/**
 * Everything one service's analysis found. A stage's facts are missing exactly when its
 * collection failed for this service, which `failed` then records: a throw while collecting
 * the service, or a global step the collection needed (the repo-wide router or queue-library
 * check, the Prisma schemas, the HTTP stage's whole-repo passes), recorded in every bundle.
 * JSON round-trips unchanged.
 */
export interface ServiceFacts extends Partial<StageFacts> {
  /** The service's key. */
  service: string;
  /** The service's program root files: its own source files. */
  rootFiles: string[];
  /** The program's config problems and syntax errors. */
  programWarnings: AnalysisWarning[];
  /** Symbol nodes of its root files (never guarded: edges point at them). */
  symbols: GraphNode[];
  /** Stages whose collection failed, in stage order. */
  failed: StageFailure[];
  /** TypeScript's internal errors during its analysis, in any program's checker (ADR-0173). */
  analyzerWarnings: AnalysisWarning[];
}

/** Thrown by {@link stageFacts} when a stage's collection failed for some service. */
export class CollectionFailed extends Error {
  readonly warning: AnalysisWarning;
  constructor(warning: AnalysisWarning) {
    super(warning.message);
    this.name = "CollectionFailed";
    this.warning = warning;
  }
}

/**
 * Every service's facts for `stage`, in service order. Throws {@link CollectionFailed} with
 * the first recorded failure if the stage's collection failed for any service (the stage then
 * contributes nothing, as when it throws as a whole), and an `Error` for a bundle that has
 * neither facts nor a failure for it.
 */
export function stageFacts<S extends FactStage>(
  services: readonly ServiceFacts[],
  stage: S,
): StageFacts[S][] {
  const failure = services.flatMap((s) => s.failed).find((f) => f.stage === stage);
  if (failure) throw new CollectionFailed(failure.warning);
  return services.map((s) => {
    const facts = s[stage];
    if (facts === undefined) throw new Error(`no ${stage} facts for service ${s.service}`);
    return facts as StageFacts[S];
  });
}
