import axios from "axios";

/** Every request through this instance is resolved against `/api`. */
export const api = axios.create({ baseURL: "/api" });

/** An env base whose fallback is trimmed of trailing slashes first (M12.1a). */
export const trimmed = axios.create({
  baseURL: (process.env.API_URL || "/api/").replace(/\/+$/, ""),
});
