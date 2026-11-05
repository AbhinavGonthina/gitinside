import client from "#http";

/** The admin page's weekly numbers. */
export async function weeklyReport(): Promise<unknown> {
  const response = await client.get("/reports/weekly");
  return response.data;
}
