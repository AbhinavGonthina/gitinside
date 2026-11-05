# express-inline-calls

Tests: calls from inline Express handlers (M6.11d). A router's inline arrow handlers, one behind
middleware and one wrapped in `asyncHandler(…)`, call repo functions; each call becomes a `calls`
edge from the handler's route, not from the file or nothing. A callback at top level that no route
serves still makes no edge, and a named middleware keeps its `handles` edge.
