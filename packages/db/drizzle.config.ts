import { defineConfig } from "drizzle-kit";

// `pnpm --filter @gitinside/db generate` writes a new SQL migration to
// drizzle/ after a change to src/schema.ts. Commit both together; the
// "migrations match the schema" test fails otherwise.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
});
