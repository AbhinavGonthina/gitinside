import express, { Router } from "express";
import users from "./routes/users";

export function health(req: unknown, res: { send(body: string): void }) {
  res.send("ok");
}

class App {
  public app: express.Application;
  private admin!: Router;

  constructor() {
    this.app = express();
    this.admin = Router();
    this.middleware();
    this.routes();
  }

  private middleware() {
    this.app.use(express.json());
  }

  private routes() {
    this.admin.post("/cache/flush", (req, res) => res.sendStatus(204));
    this.app.use("/api", users);
    this.app.use("/admin", this.admin);
    this.app.get("/health", health);
  }
}

export default new App().app;
