const API = "/api";

/** A function declaration that returns one template. */
export function shelfPath(shelfId: string) {
  return `${API}/shelves/${shelfId}`;
}

/** A const object of builders: an arrow calling another builder, and a shorthand one. */
export const shelfUrls = {
  books: (shelfId: string) => `${shelfPath(shelfId)}/books`,
  shelfPath,
} as const;

/** An arrow `const` that concatenates. */
export const loanUrl = (loanId: string) => API + "/loans/" + loanId;

/** Not a builder: it changes its argument with `replace`, so its result isn't read. */
export const trimSlashes = (base: string) => base.replace(/\/+$/, "");
