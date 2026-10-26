import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { compareStrings, nodeId, type GraphNode } from "@gitinside/schema";
import { serviceForFile, type Workspace, type WorkspacePackage } from "./workspace.js";

function dirname(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** The path of `path` inside the service folder (`apps/api/src/a.ts` → `src/a.ts`). */
function withinService(service: WorkspacePackage, path: string): string {
  return service.dir === "" ? path : path.slice(service.dir.length + 1);
}

/** The node ID of a file: `file:<service>/<service-relative path>`. */
export function fileNodeId(service: WorkspacePackage, path: string): string {
  return nodeId("file", service.key, withinService(service, path));
}

/**
 * Build `module` and `file` nodes for the inventory's source files.
 *
 * - A module is a folder that directly contains source files, except the service root
 *   (those files hang off the service). Its parent is the nearest ancestor module inside
 *   the same service, else the service.
 * - A file's parent is its folder's module, or the service for root-level files. Its `hash`
 *   is the SHA-256 of the raw bytes, so it only changes when the content does.
 * - IDs use the service-relative path; the `path` field is repo-relative.
 *
 * Not handled: folders with no source files of their own get no module (a folder that only
 * holds sub-folders is skipped, and its children attach to the next ancestor module); files
 * outside every service (possible in workspace repos) get no node.
 */
export async function buildFileNodes(
  root: string,
  workspace: Workspace,
  sourceFiles: readonly string[],
): Promise<GraphNode[]> {
  const owned = sourceFiles.flatMap((path) => {
    const service = serviceForFile(workspace, path);
    return service ? [{ path, service }] : [];
  });

  /** Module folders (repo-relative) per service key. */
  const moduleDirs = new Map<string, Set<string>>();
  for (const { path, service } of owned) {
    const dir = dirname(path);
    if (dir === service.dir) continue;
    const set = moduleDirs.get(service.key) ?? new Set<string>();
    set.add(dir);
    moduleDirs.set(service.key, set);
  }

  const parentOf = (service: WorkspacePackage, dir: string): string => {
    const dirs = moduleDirs.get(service.key);
    for (let d = dir; d !== service.dir; d = dirname(d)) {
      if (dirs?.has(d)) return nodeId("module", service.key, withinService(service, d));
    }
    return nodeId("service", service.key, "");
  };

  const nodes: GraphNode[] = [];
  for (const service of workspace.packages) {
    for (const dir of [...(moduleDirs.get(service.key) ?? [])].sort(compareStrings)) {
      nodes.push({
        id: nodeId("module", service.key, withinService(service, dir)),
        kind: "module",
        label: basename(dir),
        parentId: parentOf(service, dirname(dir)),
        path: dir,
      });
    }
  }

  for (const { path, service } of owned) {
    const bytes = await readFile(join(root, path));
    nodes.push({
      id: fileNodeId(service, path),
      kind: "file",
      label: basename(path),
      parentId: parentOf(service, dirname(path)),
      path,
      hash: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  return nodes;
}
