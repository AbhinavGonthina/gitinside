// A repo function that happens to be called `ofetch`: not the library, so not a request.
function ofetch(path: string) {
  return path;
}

export function label() {
  return ofetch("/api/users");
}
