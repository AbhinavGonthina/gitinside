import { createApi, fetchBaseQuery } from "@reduxjs/toolkit/query/react";
import type { BaseQueryFn, FetchArgs, FetchBaseQueryError } from "@reduxjs/toolkit/query";

const rawBaseQuery = fetchBaseQuery({ baseUrl: "/api/" });

// RTK's documented re-authorization wrapper: retry once after refreshing the session.
const baseQueryWithReauth: BaseQueryFn<string | FetchArgs, unknown, FetchBaseQueryError> = async (
  args,
  api,
  extraOptions,
) => {
  let result = await rawBaseQuery(args, api, extraOptions);
  if (result.error && result.error.status === 401) {
    await rawBaseQuery("session/refresh", api, extraOptions);
    result = await rawBaseQuery(args, api, extraOptions);
  }
  return result;
};

export const sessionApi = createApi({
  reducerPath: "session",
  baseQuery: baseQueryWithReauth,
  endpoints: ({ query, mutation }) => ({
    me: query<{ name: string }, void>({ query: () => "session" }),
    logOut: mutation<void, void>({ query: () => ({ url: "session", method: "DELETE" }) }),
  }),
});

export const { useMeQuery, useLogOutMutation } = sessionApi;
