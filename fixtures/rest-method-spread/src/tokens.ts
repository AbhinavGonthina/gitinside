import { postForm, sendJson, type JsonInit } from "./request";

export const readToken = () => sendJson("/api/tokens");

export const storeToken = (token: string) =>
  sendJson("/api/tokens", { method: "PUT", payload: { token } });

export const dropToken = () => sendJson("/api/tokens", { method: "DELETE" });

export const readProfile = (init: JsonInit) => sendJson("/api/profile", init);

export const uploadAvatar = (form: FormData) =>
  postForm("/api/avatar", { method: "PUT", body: form });

/** The method comes from this function's caller, so only it could say which route is meant. */
export const tokenRequest = (init: JsonInit) => sendJson("/api/tokens", init);
