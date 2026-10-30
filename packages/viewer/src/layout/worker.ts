// The layout's Web Worker (M4b.2b, ADR-0107), built as the library entry
// `@gitinside/viewer/layout-worker`. ELK's worker script is the whole body:
// loaded where there's no document, it answers ELK's own messages
// (`register`, `layout`) on `self`, which `createLayoutEngine` sends through
// elkjs's API. Results are read back on the main thread with `readLayout`.
// `workerSetup` runs first so the script survives the host's bundler.
import "./workerSetup.js";
import "elkjs/lib/elk-worker.min.js";
