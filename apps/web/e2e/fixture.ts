/** What the seeded E2E server serves (M4b.14a): `fixtures/shop-demo` at one commit. */

/** The commit `database.ts` seeds a finished analysis of. */
export const E2E_SHA = "5e2e0000000000000000000000000000000000a1";

/**
 * Ports: the unconfigured site, the seeded site, the seeded site's database, the signed-in
 * site (the same database, with sign-in set up; M8.2c), and its fake GitHub.
 */
export const PORTS = {
  unconfigured: 3107,
  seeded: 3108,
  database: 3109,
  signedIn: 3110,
  github: 3111,
} as const;

/** The signed-in site's `SESSION_SECRET`: a test value, never a real one. */
export const E2E_SESSION_SECRET = "e2e-session-secret-not-a-real-one-0123456789";
/** The app slug the signed-in site links installs to. */
export const E2E_APP_SLUG = "gitinside-e2e";
