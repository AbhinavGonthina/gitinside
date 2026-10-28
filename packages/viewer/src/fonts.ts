// Geist and Geist Mono (SIL OFL 1.1), self-hosted from the Fontsource
// packages. The library build keeps these imports external (vite.config.ts),
// so the app's bundler copies the woff2 files to its own origin and the
// browser fetches only the unicode-range subsets a page uses. No font ever
// comes from a third-party CDN (ADR-0047).
import "@fontsource-variable/geist/index.css";
import "@fontsource-variable/geist-mono/index.css";
