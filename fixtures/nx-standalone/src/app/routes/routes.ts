import { Router } from "express";
import tagController from "./tag/tag.controller";

const api = Router().use(tagController);

export default Router().use(api);
