# infra-test-folders

Tests: compose and env files in test and fixture folders aren't the repo's infrastructure (M9.3e, ADR-0262). The root `docker-compose.yml` ⇒ `datastore:infra/db` (postgres), and the Prisma datasource, whose `DATABASE_URL` no env file sets, links to it as the only postgres service (`heuristic`). `test/docker-compose.yml` (a test database and cache), `test/fixtures/sample-app/` (a sample repo's compose and `.env.example`), and `e2e/.env.example` are never read, so they add no datastore or queue and don't make the link ambiguous.
