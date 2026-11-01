import axios from "axios";

const API_URL = process.env.REACT_APP_API_URL || "http://localhost:9000";
axios.defaults.baseURL = `${API_URL}/api/v1`;
axios.defaults.withCredentials = true;

export const getUser = (id: string) => axios.get(`/users/${id}`);
