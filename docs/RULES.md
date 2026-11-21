# Architecture rules (`.gitinside.yml`)

A repo can state rules about its own architecture in a `.gitinside.yml` file at its root: which parts may depend on which, that services don't depend on each other in a cycle, who may touch a datastore, and which outside hosts the code may call. GitInside checks them against the graph it builds from the code. On a pull request it reports only the violations the PR introduces (the PR bot part is M15.1).

The file is read as data and never executed. The engine is `packages/rules` (ADR-0300).

## Example

```yaml
version: 1

layers:
  web:
    services: ["@shop/web"]
  api:
    services: ["@shop/api"]
  billing:
    paths: ["apps/api/src/billing/**"]
  routes:
    paths: ["apps/api/src/routes/**"]

rules:
  - id: routes-skip-billing
    type: forbid-dependency
    from: routes
    to: billing
    edges: [calls, imports]

  - type: no-service-cycles

  - id: only-api-touches-postgres
    type: datastore-access
    datastore: postgres
    only: [api]

  - id: known-hosts
    type: no-new-hosts
    level: warning
    allow: ["*.stripe.com"]
```

The full example, checked against the `shop-demo` fixture in tests, is `packages/rules/fixtures/shop-demo.gitinside.yml`.

## The file

| Key | What it is |
| --- | --- |
| `version` | Required, `1`. A file with another version is an error, not a guess. |
| `layers` | Optional. Named groups of code, each with `services`, `paths`, or both (lists of globs). |
| `rules` | Required (may be `[]`). At most 200. |

**A layer** holds every piece of code (file, function, class, route, page, model) whose service's name matches one of its `services` globs (the name shown on the service's box, usually its `package.json` `name`), or whose file's path from the repo root matches one of its `paths` globs. Datastores, outside hosts, queues, and requests GitInside couldn't resolve belong to no layer.

**Every rule** has a `type`, an optional `id` (letters, digits, `-`, `_`, `.`; by default `<type>-<n>`, its position from 1), and an optional `level`: `error` (the default) or `warning`.

## Rule types

### `forbid-dependency`

```yaml
- type: forbid-dependency
  from: web
  to: api
  edges: [imports, calls] # optional; all kinds by default
```

Every edge from code in layer `from` to code in layer `to` is a violation: an import, a call, a request (`http`), a read or write of a model, and so on. `edges` limits it to some kinds: `imports`, `calls`, `http`, `handles`, `renders`, `reads`, `writes`, `stores`, `publishes`, `consumes`, `external_call`.

A request or call GitInside couldn't resolve isn't counted as a violation. It's listed as **uncertain** ("may depend on"), so it's shown rather than judged.

### `no-service-cycles`

```yaml
- type: no-service-cycles
```

Services that depend on each other in a cycle, through any resolved edge between them (imports, calls, requests, …). Each cycle is one violation listing its services, with one edge per pair of services as evidence.

### `datastore-access`

```yaml
- type: datastore-access
  datastore: postgres # a glob over the datastore's name or engine
  only: [api] # layers whose code may touch it
```

Every edge into a matching datastore, or into a model it stores, from code outside the `only` layers. Raw SQL queries GitInside couldn't read aren't judged, since which datastore they reach isn't known.

### `no-new-hosts`

```yaml
- type: no-new-hosts
  allow: ["api.stripe.com", "*.amazonaws.com"] # optional
```

On a pull request: every outside host the PR adds a call to, unless it matches `allow`. On a whole graph: every host the code calls that doesn't match `allow`.

## Globs

| Pattern | Matches |
| --- | --- |
| `*` | any run of characters other than `/` |
| `?` | one character other than `/` |
| `**/` | zero or more whole folders (`src/**/x.ts` matches `src/x.ts` and `src/a/b/x.ts`) |
| `/**` at the end | everything below the folder (`src/**` matches `src/a.ts`, not `src`) |
| `**` alone | everything |

Matching is case-sensitive. Character classes (`[a-z]`), braces (`{a,b}`), negation (`!x`), escapes (`\`), and `**` inside a name (`a**`) aren't supported, and are errors rather than silently read some other way. Globs are matched in time proportional to the text times the pattern, never by backtracking, so no pattern can make a check slow.

## Errors

Every problem in the file is reported, each with its place (`rules.2.from`) and line: YAML syntax, duplicate keys, an unknown key, a wrong type, an unknown rule `type`, a bad glob, a rule naming a layer that doesn't exist, a rule from a layer to itself, two rules with one `id`.

**Limits** (so a config can't hold up a check; docs/SECURITY.md): the file at most 64 KiB, at most 200 rules, 100 layers, 100 globs in a list, and 256 characters per glob. YAML anchors and aliases (`&`, `*`) aren't allowed. Checking stops after a time budget (20 s for a pull request's two sides) and says so as an error in the config.

## On a pull request

When the GitInside GitHub App is installed, every pull request's diff job checks the rules in the head commit's `.gitinside.yml` (a regular file at the repo's root: a symlink, or a file in a subfolder, doesn't count). The bot's comment gets an "Architecture rules" section listing each violation the PR introduces with its call sites, and its Check Run (`GitInside`) concludes:

- `failure` when the PR breaks an `error`-level rule;
- `neutral` when it breaks only `warning` rules, or the file can't be checked (each problem listed with its place and line, as above), or connections break;
- `success` otherwise.

A problem in the file never fails the job: the diff and the comment are still posted. When the PR adds or edits `.gitinside.yml`, its own rules are used and the comment says so; a PR that removes it gets no rules section. New connections GitInside couldn't resolve that leave a `forbid-dependency` rule's `from` layer are counted, not judged. The file is read once, when the diff is made, and kept with it (Postgres refuses U+0000, so a file holding one is checked with U+FFFD in its place; a file over 64 KiB is reported as too large), so a retried post checks exactly what the first one did. The check gets at most 20 s, less when the job is nearly out of time (then the section says no time was left; push again to retry).

The rules are checked on both the PR's base and head, and only head's violations that base doesn't have are reported. A violation is the same on both sides when it's about the same thing: the same edge (kind and both ends) for `forbid-dependency` and `datastore-access`, the same services for a cycle, the same host. A file the PR renames or moves keeps its violations (they're not new), and a new call on an edge that already broke a rule isn't new either.
