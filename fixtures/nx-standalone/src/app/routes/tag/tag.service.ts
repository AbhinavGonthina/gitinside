const TAGS = ["dragons", "training"];

/** The tags in use, most popular first. */
export async function getTags(): Promise<string[]> {
  return [...TAGS];
}
