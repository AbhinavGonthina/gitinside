# fake-secrets

Tests: no secret reaches the graph (SECURITY.md T5). Every planted value contains `gi_fake` or `gi-fake`: credentials, hosts, paths, and query strings in `.env` and `.env.production` URLs, plain and multi-line env values, compose `environment` and `command`, credentials in a literal `fetch` URL, and hardcoded keys in `fetch` options next to an unresolved and a route-less URL. The test asserts the serialized graph contains none of them, and that the detectors still ran (a datastore, an external node, unresolved nodes).

`.env` and `.env.production` are committed on purpose (see the `.gitignore` exception); the values are fake.
