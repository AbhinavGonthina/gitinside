/** Reads the running server's tags. */
export async function readTags(): Promise<unknown> {
  const res = await fetch("http://localhost:3000/api/tags");
  return res.json();
}
