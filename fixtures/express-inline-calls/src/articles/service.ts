export interface Article {
  slug: string;
  body: string;
}

const store = new Map<string, Article>();

export async function createArticle(slug: string, body: string): Promise<Article> {
  const article = { slug, body };
  store.set(slug, article);
  return article;
}

export async function listArticles(): Promise<Article[]> {
  return [...store.values()];
}

export async function deleteArticle(slug: string): Promise<void> {
  store.delete(slug);
}

export function toSlug(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, "-");
}
