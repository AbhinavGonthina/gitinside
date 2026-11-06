const API = "/api";

async function send(path: string, query?: Record<string, string>) {
  let url = `${API}${path}`;
  if (query) {
    const search = new URLSearchParams(query).toString();
    if (search) url += `?${search}`;
  }
  const res = await fetch(url);
  return res.json();
}

export const listTracks = (genre?: string) => send("/tracks", genre ? { genre } : undefined);
export const showTrack = (trackId: string) => send(`/tracks/${trackId}`);

export async function listened(user?: string, day?: string) {
  let url = `${API}/history?`;
  if (user) {
    url += `user=${user}`;
  } else {
    url += `day=${day}`;
  }
  return fetch(url);
}

export async function playlists(owner: string, mine: boolean) {
  // This append may change the path, so the request that takes it stays unknown.
  let url = `${API}/playlists`;
  if (mine) url += `/${owner}`;
  return fetch(url);
}
