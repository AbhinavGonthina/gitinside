import type { ArchitectureGraph } from "@gitinside/schema";
import { Explorer, ViewerRoot } from "@gitinside/viewer";
import "@gitinside/viewer/fonts";
import "@gitinside/viewer/styles.css";
import { createRoot } from "react-dom/client";

// The render benchmark's page (M4b.13b): the explorer as the website draws it
// (production React, ELK in a Web Worker, dark theme, no hints), on the case
// named by `?case=`, which src/render.ts wrote to cases/<case>.json.

const layoutWorker = () =>
  new Worker(new URL("./layoutWorker.ts", import.meta.url), {
    type: "module",
    name: "gitinside-layout",
  });

const name = new URLSearchParams(window.location.search).get("case") ?? "";
const response = await fetch(`cases/${encodeURIComponent(name)}.json`);
if (!response.ok) throw new Error(`no case ${name}: ${response.status}`);
const { graph, open } = (await response.json()) as { graph: ArchitectureGraph; open: string[] };

const root = document.getElementById("root");
if (!root) throw new Error("no #root");
createRoot(root).render(
  <ViewerRoot theme="dark">
    <Explorer graph={graph} initialOpen={open} layoutWorker={layoutWorker} />
  </ViewerRoot>,
);
