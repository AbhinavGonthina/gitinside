import { expect, test } from "@playwright/test";

const API = "http://localhost:4000";

export async function readHealth(): Promise<boolean> {
  const res = await fetch(`${API}/api/health`);
  return res.ok;
}

test("the API answers", async () => {
  expect(await readHealth()).toBe(true);
});
