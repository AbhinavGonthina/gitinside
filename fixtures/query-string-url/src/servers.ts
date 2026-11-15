import * as queryString from "query-string";
import { stringifyUrl } from "query-string";

export async function listServers(page: number) {
  return fetch(queryString.stringifyUrl({ url: "/api/servers", query: { page } }));
}

/** A control: a named import isn't read, so the URL stays unresolved. */
export async function searchServers(term: string) {
  return fetch(stringifyUrl({ url: "/api/servers", query: { term } }));
}
