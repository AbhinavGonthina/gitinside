// What a hostile repo runs when someone installs, builds, or loads it. If GitInside ever
// executed this repo, the sentinel file PWNED would appear next to package.json and a
// shell command would start. The security suite checks that neither happens.
const { execSync } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");

writeFileSync(join(__dirname, "..", "PWNED"), `ran from ${process.argv[2] ?? "require"}\n`);
execSync("echo pwned");
