/**
 * Words shared by the server and the browser, in a module with no imports so client
 * components can use them without pulling in the database code.
 */

/** UX.md's words for the worker being down. */
export const UNAVAILABLE_MESSAGE =
  "Analysis is temporarily unavailable. Already-analyzed repos still work.";
