/** What the seeded E2E server serves (M4b.14a): `fixtures/shop-demo` at one commit. */

/** The commit `database.ts` seeds a finished analysis of. */
export const E2E_SHA = "5e2e0000000000000000000000000000000000a1";

/**
 * Ports: the unconfigured site, the seeded site, the seeded site's database, the signed-in
 * site (sign-in set up; M8.2c), its fake GitHub, and its own database. Each database is one
 * PGlite session, so the two sites don't share one: a site's queries can't land inside the
 * other's transaction or session state.
 */
export const PORTS = {
  unconfigured: 3107,
  seeded: 3108,
  database: 3109,
  signedIn: 3110,
  github: 3111,
  signedInDatabase: 3112,
} as const;

/**
 * The signed-in site's private repos (M8.4c2c), in installation 41 on `acme` (`github.ts`):
 * `acme/storefront` has a finished analysis at {@link E2E_SHA} (its diagram), and
 * `acme/billing-service` a running one at `billing.sha`, each by its `job`. `id` is GitHub's
 * repo ID.
 */
export const E2E_PRIVATE = {
  installationId: 41,
  storefront: { id: 501, job: `analyze-${"5".repeat(32)}` },
  billing: {
    id: 502,
    job: `analyze-${"b".repeat(32)}`,
    sha: "5e2e0000000000000000000000000000000000b2",
  },
} as const;

/** The signed-in site's `SESSION_SECRET`: a test value, never a real one. */
export const E2E_SESSION_SECRET = "e2e-session-secret-not-a-real-one-0123456789";
/** The app slug the signed-in site links installs to. */
export const E2E_APP_SLUG = "gitinside-e2e";
