import { ofetch } from "ofetch";

/** Every request under `/api`. */
export const api = ofetch.create({ baseURL: "/api" });

/** The v2 endpoints: its own base replaces the parent's. */
export const v2 = api.create({ baseURL: "/api/v2" });

/** Keeps `/api` and posts unless a call says otherwise. */
export const poster = api.create({ method: "POST" });
