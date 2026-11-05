import { loanUrl, shelfUrls, trimSlashes } from "./paths";

export async function openShelf(shelfId: string) {
  const res = await fetch(shelfUrls.shelfPath(shelfId));
  return res.json();
}

export async function listBooks(shelfId: string) {
  const res = await fetch(shelfUrls.books(shelfId));
  return res.json();
}

export async function addBook(shelfId: string, title: string) {
  await fetch(shelfUrls.books(shelfId), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
  });
}

export async function returnLoan(loanId: string) {
  await fetch(loanUrl(loanId), { method: "DELETE" });
}

export async function searchCatalog(query: string) {
  const res = await fetch(trimSlashes("/api/catalog/") + "/search?q=" + query);
  return res.json();
}
