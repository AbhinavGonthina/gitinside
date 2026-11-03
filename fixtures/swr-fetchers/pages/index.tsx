import useSWR from "swr";
import { useAddBook, useBookPages } from "../hooks/books";

interface Shelf {
  name: string;
  count: number;
}

export default function Home() {
  const { data: shelves } = useSWR<Shelf[]>("/api/shelves");
  const { data: pages } = useBookPages();
  const { trigger } = useAddBook();
  const { data: token } = useSWR(["/api/session", "token"]);
  return (
    <main>
      <h1>{shelves?.length ?? 0} shelves</h1>
      <p>{pages?.flat().length ?? 0} books</p>
      <p>{token ? "signed in" : "signed out"}</p>
      <button onClick={() => trigger({ title: "Dune" })}>Add</button>
    </main>
  );
}
