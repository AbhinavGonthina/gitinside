export { applyDiff, DiffApplyError } from "./apply.js";
export { checkComparable, describeRepo, IncompatibleGraphsError } from "./compare.js";
export { diffGraphs, type DiffOptions } from "./diff.js";
export {
  detectRenames,
  RENAME_THRESHOLDS,
  similarity,
  tokenize,
  type FileContents,
} from "./rename.js";
export {
  changedFields,
  EDGE_FINGERPRINT,
  EDGE_INCIDENTAL,
  NODE_FINGERPRINTS,
  NODE_INCIDENTAL,
} from "./fingerprint.js";
