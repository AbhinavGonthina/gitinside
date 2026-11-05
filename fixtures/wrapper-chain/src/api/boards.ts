import { getCached, getJson, postJson } from "./client";

export const loadBoard = (id: string) => getJson("boards/" + id);

export const listBoards = (page: number) => getJson("boards", `page=${page}`);

export const createBoard = (board: unknown) => postJson("boards", board);

export const loadStats = () => getCached("stats");
