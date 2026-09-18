import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { config } from "./config.js";
import { ApiError } from "./lib/http.js";
import { HttpError } from "./lib/errors.js";
import { log } from "./lib/logger.js";
import { apiRouter } from "./routes/api.js";
import { authRouter } from "./routes/auth.js";
import { mediaRouter } from "./routes/media.js";
import { canvaUiRouter } from "./routes/canva-ui.js";
import { InstagramClient } from "./instagram/client.js";
import * as mediaStore from "./store/mediaStore.js";
import * as tokens from "./store/tokenStore.js";
import * as liveSessions from "./canva-ui/live-session.js";

const here = dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: "1mb" }));
app.use(express.static(resolve(here, "../public")));

app.use("/auth", authRouter);
app.use("/api", apiRouter);
app.use("/media", mediaRouter);
app.use("/api/canva-ui", canvaUiRouter);

app.get("/healthz", (_req, res) => res.json({ ok: true, mediaMode: config.mediaMode }));

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = err instanceof ApiError || err instanceof HttpError ? err.status : 500;
  const code = err instanceof HttpError ? err.code : "request_failed";
  const message = err instanceof Error ? err.message : "Unexpected error";
  log[status >= 500 ? "error" : "warn"](`${status} ${message}`);
  res.status(status >= 400 && status < 600 ? status : 500).json({ error: code, message });
});

async function boot(): Promise<void> {
  mediaStore.startJanitor();
  liveSessions.startJanitor();

  const token = await tokens.load();
  log.info(`Canva: ${token ? "connected" : "not connected — open /auth/canva"}`);

  if (config.instagram.accessToken && !config.instagram.userId) {
    try {
      const account = await InstagramClient.discoverAccount(config.instagram.accessToken);
      log.info(`Instagram: @${account.username ?? account.id} (id ${account.id})`);
    } catch (err) {
      log.warn(`Instagram account discovery failed: ${(err as Error).message}`);
    }
  } else if (config.instagram.userId) {
    log.info(`Instagram: using IG_USER_ID ${config.instagram.userId}`);
  } else {
    log.warn("Instagram: IG_ACCESS_TOKEN not set — publishing is disabled (dry runs still work)");
  }

  app.listen(config.port, () => {
    log.info(`Listening on http://127.0.0.1:${config.port}`);
    log.info(`Media mode: ${config.mediaMode} | Token store: ${config.tokenStore}`);
  });
}

boot().catch((err) => {
  log.error("Failed to start", (err as Error).message);
  process.exit(1);
});
