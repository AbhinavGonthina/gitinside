/** `CMS_URL` isn't named like an API base, so this is shown as unresolved, not guessed. */
export async function latestPosts() {
  const res = await fetch(`${process.env.CMS_URL}/posts`);
  return res.json();
}
