import ky from "ky";

/** ky 1's `prefixUrl`: every request under `/api`. */
export const api = ky.create({ prefixUrl: "/api" });

/** `extend` keeps the parent's `/api` and posts unless a call says otherwise. */
export const writer = api.extend({ method: "post" });

/** ky 2's `baseUrl`: URLs resolve against it like links in a page. */
export const v1 = ky.create({ baseUrl: "/api/v1/" });
