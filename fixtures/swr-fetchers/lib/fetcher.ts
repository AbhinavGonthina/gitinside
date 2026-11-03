import axios from "axios";

/** The app's SWR fetcher: SWR calls it with the hook's key. */
export const fetcher = (url: string) => axios.get(url).then((res) => res.data);

/** A mutation fetcher: `useSWRMutation` calls it with the key and `{ arg }`. */
export async function addToShelf(url: string, { arg }: { arg: { title: string } }) {
  const res = await axios.post(url, arg);
  return res.data;
}
