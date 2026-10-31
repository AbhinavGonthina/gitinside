// The layout worker's entry, as the website's (`apps/web/app/[owner]/[repo]/layoutWorker.ts`):
// the viewer's worker module, bundled by Vite from `new Worker(new URL(...))` in main.tsx.
import "@gitinside/viewer/layout-worker";
