import { tasksApi } from "./api";

export const labelsApi = tasksApi.injectEndpoints({
  endpoints(build) {
    return {
      listLabels: build.query<string[], void>({ query: () => "/labels" }),
    };
  },
});

export const { useListLabelsQuery } = labelsApi;
