import axios from "axios";

/** The app's HTTP client: every request goes to the same origin's `/api`. */
const client = axios.create({ baseURL: "/api", timeout: 5000 });

export default client;
