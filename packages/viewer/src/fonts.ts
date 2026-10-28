// Geist and Geist Mono (SIL OFL 1.1), self-hosted from the Fontsource
// packages. This is its own library entry, `@gitinside/viewer/fonts`, imported
// once by the app (apps/web's root layout) and by Storybook's preview, so the
// main entry stays importable from plain Node (ADR-0056). The library build
// keeps these imports external (vite.config.ts), so the app's bundler copies
// the woff2 files to its own origin and the browser fetches only the
// unicode-range subsets a page uses. No font ever comes from a third-party CDN
// (ADR-0047).
import "@fontsource-variable/geist/index.css";
import "@fontsource-variable/geist-mono/index.css";
