import express from "express";
import routes from "./app/routes/routes";

const app = express();
app.use(express.json());
app.use("/api", routes);

app.listen(3000);
