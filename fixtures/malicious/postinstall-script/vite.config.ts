// Vite evaluates its config on every command.
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";

writeFileSync(new URL("./PWNED", import.meta.url), "ran from vite.config.ts\n");
execSync("echo pwned");

export default {};
