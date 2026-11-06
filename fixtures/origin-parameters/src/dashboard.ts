import { latestReadings, readStation, waitForStation } from "./probe";

export async function boot(port = 4400) {
  await waitForStation(port);
  const first = await readStation(port, "/api/readings");
  const again = await latestReadings(port);
  return [await first.json(), await again.json()];
}
