import axios from "axios";
import qs from "query-string";

export async function createChannel(serverId: string, values: object) {
  const url = qs.stringifyUrl({
    url: "/api/channels",
    query: { serverId },
  });
  await axios.post(url, values);
}

export async function deleteChannel(channelId: string, serverId: string) {
  const url = qs.stringifyUrl({
    url: `/api/channels/${channelId}`,
    query: { serverId },
  });
  await axios.delete(url);
}

export async function changeRole(memberId: string, serverId: string, role: string) {
  const url = qs.stringifyUrl({ url: `/api/members/${memberId}`, query: { serverId } });
  await axios.patch(url, { role });
}

/** A wrapper: the caller's path reaches `url`, so the request is drawn at the caller. */
async function page(url: string, cursor?: string) {
  return axios.get(qs.stringifyUrl({ url, query: { cursor } }, { skipNull: true }));
}

export const messages = () => page("/api/messages");

/** A control: the path comes from whoever opened the modal, so it stays unresolved. */
export async function deleteMessage(data: { apiUrl?: string; query?: object }) {
  const url = qs.stringifyUrl({ url: data.apiUrl || "", query: data.query });
  await axios.delete(url);
}
