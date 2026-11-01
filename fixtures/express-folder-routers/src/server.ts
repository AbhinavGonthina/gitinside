import express from "express";
import mountLegacy from "./legacy";
import routers from "./routes/createRouter";

const app = express();
app.use("/api", routers);
mountLegacy(app);
app.get("/health", (req, res) => res.send("ok"));

export default app;
