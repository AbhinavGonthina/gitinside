/** Create React App's `"proxy"` sends every request on unchanged. */
export async function loadStats() {
  const res = await fetch("/stats");
  return res.json();
}
