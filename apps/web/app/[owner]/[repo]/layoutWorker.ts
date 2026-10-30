// The diagram's layout worker (M4b.3b2, ADR-0107): the viewer's worker entry,
// ELK's own worker script, built by Next.js from `RepoDiagram`'s
// `new Worker(new URL("./layoutWorker.ts", import.meta.url))`. The bundler
// only builds a worker from a path it can see, so this file is that path.
import "@gitinside/viewer/layout-worker";
