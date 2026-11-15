import { createApi, fetchBaseQuery } from "@reduxjs/toolkit/query/react";

export const originApi = createApi({
  reducerPath: "origin",
  baseQuery: fetchBaseQuery({
    baseUrl: window.location.protocol + "//" + window.location.host + "/api",
  }),
  endpoints: (build) => ({
    originStats: build.query<unknown, void>({ query: () => "stats" }),
  }),
});

export const templateApi = createApi({
  reducerPath: "template",
  baseQuery: fetchBaseQuery({ baseUrl: `${location.protocol}//${location.host}/api/` }),
  endpoints: (build) => ({
    templateTasks: build.query<unknown, void>({ query: () => "tasks" }),
  }),
});

export const hostnameApi = createApi({
  reducerPath: "hostname",
  baseQuery: fetchBaseQuery({
    baseUrl: window.location.protocol + "//" + window.location.hostname + "/api",
  }),
  endpoints: (build) => ({
    hostnameStats: build.query<unknown, void>({ query: () => "stats" }),
  }),
});
