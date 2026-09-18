import { Router, type Request } from "express";
import { config } from "../config.js";
import { CanvaClient } from "../canva/client.js";
import { InstagramClient } from "../instagram/client.js";
import { ApiError } from "../lib/http.js";
import { HttpError } from "../lib/errors.js";
import { log } from "../lib/logger.js";
import { instagramClient, publishDesignToInstagram, type PublishMode } from "../publish/pipeline.js";
import * as tokens from "../store/tokenStore.js";

export const apiRouter = Router();

/**
 * The browser holds the Canva access token (TOKEN_STORE=browser) and replays it
 * on each call; otherwise we fall back to the server-side store, which also
 * handles refresh. Either way the Canva call itself happens here, because
 * Canva's CORS policy blocks the API from a page.
 */
async function canvaToken(req: Request): Promise<string> {
  const header = req.get("x-canva-token")?.trim();
  if (header && config.tokenStore === "browser") return header;
  return tokens.getValidAccessToken();
}

apiRouter.get("/designs", async (req, res, next) => {
  try {
    const client = new CanvaClient(await canvaToken(req));
    const { query, continuation, limit } = req.query as Record<string, string | undefined>;
    const result = await client.listDesigns({
      query: query || undefined,
      continuation: continuation || undefined,
      limit: limit ? Number(limit) : undefined,
    });
    res.json({
      items: result.items.map((d) => ({
        id: d.id,
        title: d.title ?? "(untitled)",
        pageCount: d.page_count ?? 1,
        thumbnail: d.thumbnail?.url,
        updatedAt: d.updated_at,
        editUrl: d.urls?.edit_url,
      })),
      continuation: result.continuation,
    });
  } catch (err) {
    next(err);
  }
});

apiRouter.get("/instagram/account", async (_req, res, next) => {
  try {
    if (!config.instagram.accessToken) {
      return res.status(400).json({ error: "not_configured", message: "IG_ACCESS_TOKEN is not set." });
    }
    const account = config.instagram.userId
      ? { id: config.instagram.userId }
      : await InstagramClient.discoverAccount(config.instagram.accessToken);
    const ig = await instagramClient();
    res.json({ ...account, quota: await ig.getPublishingLimit() });
  } catch (err) {
    next(err);
  }
});

interface PublishBody {
  designId?: string;
  caption?: string;
  pages?: number[];
  mode?: PublishMode;
  dryRun?: boolean;
  ignoreAspectRatio?: boolean;
}

apiRouter.post("/publish", async (req, res, next) => {
  const body = req.body as PublishBody;
  try {
    if (!body?.designId) {
      return res.status(400).json({ error: "bad_request", message: "`designId` is required." });
    }
    const report = await publishDesignToInstagram({
      canvaAccessToken: await canvaToken(req),
      designId: body.designId,
      caption: body.caption,
      pages: body.pages,
      mode: body.mode,
      dryRun: body.dryRun,
      ignoreAspectRatio: body.ignoreAspectRatio,
    });
    res.json(report);
  } catch (err) {
    next(err);
  }
});

/** Same thing, but streams each step so the UI can show progress live. */
apiRouter.post("/publish/stream", async (req, res) => {
  const body = req.body as PublishBody;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (event: string, data: unknown) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);

  try {
    if (!body?.designId) throw new Error("`designId` is required.");
    const report = await publishDesignToInstagram({
      canvaAccessToken: await canvaToken(req),
      designId: body.designId,
      caption: body.caption,
      pages: body.pages,
      mode: body.mode,
      dryRun: body.dryRun,
      ignoreAspectRatio: body.ignoreAspectRatio,
      onProgress: (e) => send("progress", e),
    });
    send("done", report);
  } catch (err) {
    log.error("publish failed", (err as Error).message);
    const status = err instanceof ApiError || err instanceof HttpError ? err.status : undefined;
    send("error", { message: (err as Error).message, status });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});
