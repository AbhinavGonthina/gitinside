/** True once the station on `port` answers its health check. */
export function stationUp(port: number) {
  return fetch(`http://127.0.0.1:${port}/api/health`);
}

/** Poll the station until it is up. */
export async function waitForStation(port: number) {
  for (let tries = 0; tries < 20; tries++) {
    const res = await stationUp(port).catch(() => undefined);
    if (res?.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`station on ${port} never came up`);
}

/** Read any of the station's endpoints. */
export function readStation(port: number, path: string) {
  return fetch(`http://localhost:${port}${path}`);
}

export const latestReadings = (port: number) => readStation(port, "/api/readings");
