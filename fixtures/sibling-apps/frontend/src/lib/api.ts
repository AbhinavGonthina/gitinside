import axios from "axios";

/** Every request through this instance is resolved against `/api`. */
const api = axios.create({ baseURL: "/api" });

export default api;
