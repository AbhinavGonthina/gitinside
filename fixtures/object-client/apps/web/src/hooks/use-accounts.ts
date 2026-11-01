import { apiClient } from "../lib/api-client";

export interface Account {
  id: string;
  name: string;
}

export function listAccounts(page: number) {
  return apiClient.get<Account[]>("/accounts", { page: String(page) });
}

export function createAccount(name: string) {
  return apiClient.post<Account>("/accounts", { name });
}

export function renameAccount(id: string, name: string) {
  return apiClient.patch<Account>(`/accounts/${id}`, { name });
}

export function deleteAccount(id: string) {
  return apiClient.delete(`/accounts/${id}`);
}
