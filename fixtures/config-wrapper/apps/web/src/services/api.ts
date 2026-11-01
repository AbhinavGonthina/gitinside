import httpRequest from "./fetcher";

const LOGOUT = { method: "DELETE", url: "/logout" } as const;

export const login = (username: string, password: string) =>
  httpRequest<{ id: string }>({
    method: "POST",
    url: "/authenticate",
    data: { username, password },
  });

export const getPost = (postID: string) =>
  httpRequest<{ id: string }>({ method: "GET", url: `/post/${postID}` });

export const logout = () => httpRequest<void>(LOGOUT);

export const forward = (config: object) => httpRequest<unknown>(config);
