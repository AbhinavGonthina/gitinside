import { createApi, fetchBaseQuery } from "@reduxjs/toolkit/query/react";

export interface Task {
  id: string;
  title: string;
  done: boolean;
}

export const tasksApi = createApi({
  reducerPath: "tasks",
  baseQuery: fetchBaseQuery({ baseUrl: "/api/" }),
  tagTypes: ["Task"],
  endpoints: (builder) => ({
    listTasks: builder.query<Task[], void>({
      query: () => "tasks",
      providesTags: ["Task"],
    }),
    getTask: builder.query<Task, string>({
      query: (id) => `tasks/${id}`,
    }),
    addTask: builder.mutation<Task, Pick<Task, "title">>({
      query: (body) => ({ url: "tasks", method: "POST", body }),
      invalidatesTags: ["Task"],
    }),
    finishTask: builder.mutation<Task, string>({
      query(id) {
        return { url: `tasks/${id}`, method: "PATCH", body: { done: true } };
      },
      invalidatesTags: ["Task"],
    }),
    countTasks: builder.query<number, void>({
      queryFn: () => ({ data: 0 }),
    }),
  }),
});

export const { useListTasksQuery, useGetTaskQuery, useAddTaskMutation, useFinishTaskMutation } =
  tasksApi;
