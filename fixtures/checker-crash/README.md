# checker-crash

Tests: the code shape that crashed a whole analysis in M5.8c, and the folder it came from.

- `src/schema.js` is zod's bundled `safeParse` in miniature: a constructor that rebinds `this.safeParse`, returning an object literal with a getter-only `error`. Under `strict` + `exactOptionalPropertyTypes` (this `tsconfig.json`, like `packages/viewer`), TypeScript 5.6 threw `Cannot read properties of undefined (reading 'id')` from inside `getSymbolAtLocation(this.safeParse.bind)`. It builds a "property doesn't exist" message, prints the getter's type, and finds no set accessor for a type it thinks is writable. The Express detector asked about every call's callee, so the crash failed the whole analysis.
- `storybook-static/` is Storybook's build output, where the real bundle lived (`packages/viewer/storybook-static/assets/Icon-*.js`). It must be skipped like `dist/`.

The crash never reproduced outside this repo's full checkout: the bundle alone, the whole viewer package copied with its config, and a copy of the repo without the eval/bench checkouts all analyzed fine. So this small copy doesn't crash on its own either. The fixture pins the graph for the pattern (one `POST /echo` route, no warnings), and `packages/analyzer/src/analyze.test.ts` makes the checker throw on `.bind` here to test the guard.
