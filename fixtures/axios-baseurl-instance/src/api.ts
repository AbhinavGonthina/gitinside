import axios from "axios";

/** Every request through this instance is resolved against `/api`. */
export const api = axios.create({ baseURL: "/api" });
