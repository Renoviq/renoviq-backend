import express, { type Request, Response, NextFunction } from "express";
import cors from "cors";
import { registerRoutes } from "./routes";
import { config } from "./config";

// 🔄 Import passport setup (serializers)
import "./passport";

const app = express();

function log(message: string) {
  console.log(`${new Date().toLocaleTimeString("en-US", { hour12: false })} [api] ${message}`);
}

// In production nginx serves the web app and this API from one origin, so CORS is only a
// fallback for running the web app from a different origin.
app.use(
  cors({
    origin: config.clientOrigin,
    credentials: true,
  })
);

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// 🔍 Request Logger
app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;

  res.on("finish", () => {
    // Health checks run every few seconds and would fill the log.
    if (path.startsWith("/api") && path !== "/api/health") {
      log(`${req.method} ${path} ${res.statusCode} in ${Date.now() - start}ms`);
    }
  });

  next();
});

// 🧩 Register routes
(async () => {
  const server = await registerRoutes(app);

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    res.status(err.status || err.statusCode || 500).json({ error: err.message || "Internal Server Error" });
  });

  server.listen(config.port, "0.0.0.0", () => {
    log(`listening on port ${config.port}`);
  });
})();
