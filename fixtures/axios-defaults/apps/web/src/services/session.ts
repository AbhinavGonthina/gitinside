import axios from "axios";

const session = axios.create();

export function configure(base: string) {
  session.defaults.baseURL = base;
}

export const refresh = () => session.post("/session/refresh");
