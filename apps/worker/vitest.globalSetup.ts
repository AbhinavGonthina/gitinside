import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/**
 * Build `dist/` before the tests: runner.test.ts starts the real child process, and Node
 * runs the compiled `child.js` and `netguard.js`, not the TypeScript sources under test.
 */
export default function setup(): void {
  const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  execFileSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], {
    cwd: fileURLToPath(new URL(".", import.meta.url)),
    stdio: "inherit",
  });
}
