import { latestPosts } from "../lib/cms";

export default async function Home() {
  const posts = await latestPosts();
  return <main>{posts.length} posts</main>;
}
