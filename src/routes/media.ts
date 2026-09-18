import { Router } from "express";
import * as mediaStore from "../store/mediaStore.js";

export const mediaRouter = Router();

/**
 * Serves re-hosted exports when MEDIA_MODE=proxy. Instagram's crawler hits this
 * once, right after the container is created, so it must be publicly reachable.
 */
mediaRouter.get("/:id.jpg", (req, res) => {
  const id = (req.params as Record<string, string>).id ?? "";
  const entry = mediaStore.get(id);
  if (!entry) return res.status(404).json({ error: "not_found", message: "Media expired or never existed." });

  res.setHeader("Content-Type", entry.contentType);
  res.setHeader("Content-Length", String(entry.buffer.length));
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.send(entry.buffer);
});
