/** What the seeded E2E server serves (M4b.14a): `fixtures/shop-demo` at one commit. */

/** The commit `database.ts` seeds a finished analysis of. */
export const E2E_SHA = "5e2e0000000000000000000000000000000000a1";

/** Ports: the unconfigured site, the seeded site, and the seeded site's database. */
export const PORTS = { unconfigured: 3107, seeded: 3108, database: 3109 } as const;
