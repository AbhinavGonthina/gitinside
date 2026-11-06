import { catalog, openShelf } from "./shelf";

export const showReadingNow = () => openShelf();
export const showShelf = (id: string) => openShelf(id);
export const listBooks = () => catalog("/books");
export const listBooksV2 = () => catalog("/books", "v2");
