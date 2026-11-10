import express from "express";
import path from "path";
import { readdirSync } from "fs";
import mountLegacy from "./legacy";
import routers from "./routes/createRouter";

const app = express();
app.use("/api", routers);
mountLegacy(app);
app.get("/health", (req, res) => res.send("ok"));

// Each file in ./api, whether it exports a default router or `module.exports` one.
readdirSync(path.join(__dirname, "api")).forEach((r) => {
  const route = require(path.join(__dirname, "api", r));
  const router = route.default || route;
  if (typeof router === "function") {
    app.use("/api", router);
  } else {
    console.error(`Error: ${r} does not export a valid router`);
  }
});

export default app;
