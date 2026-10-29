# postinstall-script

Tests: an analyzed repo is parsed, never executed (SECURITY.md T1). Every place a JS toolchain runs repo code calls `scripts/pwn.js` or does the same thing inline: npm lifecycle scripts (`preinstall`, `install`, `postinstall`, `prepare`, `prepack`, `build`, `start`), `next.config.js` and `vite.config.ts` (evaluated by their tools), a TypeScript language-service plugin in `tsconfig.json`, and top-level code in `src/server.ts`. The security suite (`apps/worker/src/security.test.ts`) also adds an `.npmrc` with `onload-script` and `node-options=--require` hooks to the tarball (the file can't be committed here).

Running any of it would write a sentinel file `PWNED` next to `package.json` and start a shell (`execSync`). The suite runs the fixture through the real job pipeline (fake GitHub ⇒ extraction ⇒ sandboxed analysis child) and asserts that the source folder holds exactly the archived files (no `PWNED`), that the worker started one process (the analysis child, with `--permission`), and that the analysis still found the Express route.

Never run `npm install` or any script in this folder.
