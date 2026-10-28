# ambiguous-routes

Tests: ambiguity. `fetch("/v1/acme/items")` matches both `/v1/:org/items` and `/v1/acme/:kind` at the same level, so it links to both, one level weaker, with `reason: "AMBIGUOUS"`. `` `/v1/${org}/items` `` matches only `/v1/:org/items` (`exact`), because a hole never matches a literal.
