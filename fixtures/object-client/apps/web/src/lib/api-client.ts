const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";

async function headers(): Promise<Record<string, string>> {
  return { "Content-Type": "application/json" };
}

/** One object of request helpers, each taking the endpoint path. */
export const apiClient = {
  async get<T>(endpoint: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(`${BASE_URL}${endpoint}`);
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        url.searchParams.set(key, value);
      });
    }
    const response = await fetch(url.toString(), { method: "GET", headers: await headers() });
    return (await response.json()) as T;
  },

  post: async <T>(endpoint: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${BASE_URL}${endpoint}`, {
      method: "POST",
      headers: await headers(),
      body: JSON.stringify(body),
    });
    return (await response.json()) as T;
  },

  patch: async function <T>(endpoint: string, body?: unknown): Promise<T> {
    const response = await fetch(`${BASE_URL}${endpoint}`, {
      method: "PATCH",
      headers: await headers(),
      body: JSON.stringify(body),
    });
    return (await response.json()) as T;
  },

  async delete(endpoint: string): Promise<void> {
    await fetch(`${BASE_URL}${endpoint}`, { method: "DELETE", headers: await headers() });
  },
};
