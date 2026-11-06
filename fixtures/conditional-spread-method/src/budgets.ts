const API_BASE = "/api";

async function request(path: string, method = "GET", body?: unknown) {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return response.json();
}

export const listBudgets = () => request("/budgets");

export const createBudget = (budget: { name: string }) => request("/budgets", "POST", budget);

export const removeBudget = (id: string) => request(`/budgets/${id}`, "DELETE");

export function renameBudget(id: string, name: string, override?: RequestInit) {
  return fetch(`${API_BASE}/budgets/${id}`, {
    method: "PUT",
    ...(override ? override : {}),
    body: JSON.stringify({ name }),
  });
}
