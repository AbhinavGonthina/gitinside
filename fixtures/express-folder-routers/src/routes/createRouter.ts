import { Router } from "express";
import glob from "glob";

const ext = process.env.NODE_ENV === "dev" ? "ts" : "js";

const routers = glob
  .sync(`**/*.${ext}`, { cwd: `${__dirname}/` })
  .map((filename: string) => require(`./${filename}`))
  .filter((router: any) => router.default && Object.getPrototypeOf(router.default) === Router)
  .reduce((root: Router, router: any) => root.use(router.default), Router({ mergeParams: true }));

export default routers;
