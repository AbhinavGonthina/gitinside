import axios from "axios";

const admin = axios.create({ timeout: 5000 });
admin.defaults.baseURL = "/api/admin";

export const listUsers = () => admin.get("/users");

export const ban = (id: string) => admin.post(`/users/${id}/ban`);
