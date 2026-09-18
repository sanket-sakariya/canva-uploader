/** Stand-ins for api.canva.com and graph.facebook.com, good enough to exercise
 *  the real pipeline end to end: async export job, container staging, publish. */
import express from "express";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";

export interface MockState {
  exportPolls: number;
  containers: string[];
  publishedCreationId?: string;
  publishedCaption?: string;
  carouselChildren?: string[];
  fetchedImageUrls: string[];
  imageBytesOk: boolean[];
}

export async function startMocks(opts: {
  imagePaths: string[];
  pollsBeforeSuccess?: number;
  exportFails?: { code: string; message: string };
}): Promise<{ canvaBase: string; igBase: string; state: MockState; close: () => Promise<void> }> {
  const state: MockState = { exportPolls: 0, containers: [], fetchedImageUrls: [], imageBytesOk: [] };
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  let selfOrigin = "";

  /* ── images the "export" points at ── */
  app.get("/files/:idx.jpg", (req, res) => {
    const idx = Number((req.params as any).idx);
    const path = opts.imagePaths[idx];
    if (!path) return res.status(404).end();
    res.type("image/jpeg").send(readFileSync(path));
  });

  /* ── Canva Connect ── */
  app.get("/rest/v1/designs", (_req, res) =>
    res.json({
      items: [
        { id: "DAGmock0001", title: "Mock Design", owner: { user_id: "u", team_id: "t" },
          urls: { edit_url: "https://canva.com/e", view_url: "https://canva.com/v" },
          created_at: 1, updated_at: 2, page_count: opts.imagePaths.length,
          thumbnail: { width: 100, height: 100, url: `${selfOrigin}/files/0.jpg` } },
      ],
    }),
  );

  app.get("/rest/v1/designs/:id", (req, res) =>
    res.json({
      design: { id: (req.params as any).id, title: "Mock Design", owner: { user_id: "u", team_id: "t" },
        urls: { edit_url: "https://canva.com/e", view_url: "https://canva.com/v" },
        created_at: 1, updated_at: 2, page_count: opts.imagePaths.length },
    }),
  );

  app.post("/rest/v1/exports", (req, res) => {
    const fmt = req.body?.format;
    if (fmt?.type !== "jpg") return res.status(400).json({ message: "mock expects jpg", code: "bad_format" });
    state.exportPolls = 0;
    res.json({ job: { id: "job_mock", status: "in_progress" } });
  });

  app.get("/rest/v1/exports/:id", (_req, res) => {
    state.exportPolls++;
    if (opts.exportFails) {
      return res.json({ job: { id: "job_mock", status: "failed", error: opts.exportFails } });
    }
    if (state.exportPolls < (opts.pollsBeforeSuccess ?? 2)) {
      return res.json({ job: { id: "job_mock", status: "in_progress" } });
    }
    res.json({
      job: { id: "job_mock", status: "success",
        urls: opts.imagePaths.map((_, i) => `${selfOrigin}/files/${i}.jpg`) },
    });
  });

  /* ── Instagram Graph ── */
  const IG_ID = "17841400000000000";

  app.get("/graph/v21.0/me/accounts", (_req, res) =>
    res.json({ data: [{ id: "page_1", name: "Mock Page", instagram_business_account: { id: IG_ID, username: "mockstudio" } }] }),
  );

  app.get(`/graph/v21.0/${IG_ID}/content_publishing_limit`, (_req, res) =>
    res.json({ data: [{ quota_usage: 3, config: { quota_total: 100 } }] }),
  );

  app.post(`/graph/v21.0/${IG_ID}/media`, async (req, res) => {
    const { image_url, caption, media_type, children, is_carousel_item } = req.body ?? {};
    if (media_type === "CAROUSEL") {
      state.carouselChildren = String(children).split(",");
      state.publishedCaption = caption;
      const id = `carousel_${state.containers.length}`;
      state.containers.push(id);
      return res.json({ id });
    }
    if (!image_url) return res.status(400).json({ error: { message: "image_url required", code: 100 } });

    // Instagram really does fetch the URL — so does the mock. Proves the URL we
    // hand over is publicly reachable and actually contains JPEG bytes.
    state.fetchedImageUrls.push(image_url);
    try {
      const r = await fetch(image_url);
      const buf = Buffer.from(await r.arrayBuffer());
      state.imageBytesOk.push(r.ok && buf[0] === 0xff && buf[1] === 0xd8);
    } catch {
      state.imageBytesOk.push(false);
    }
    if (!is_carousel_item && caption) state.publishedCaption = caption;
    const id = `container_${state.containers.length}`;
    state.containers.push(id);
    res.json({ id });
  });

  app.post(`/graph/v21.0/${IG_ID}/media_publish`, (req, res) => {
    state.publishedCreationId = req.body?.creation_id;
    res.json({ id: "media_mock_999" });
  });

  // Container status + permalink lookups share the /:id shape; split on `fields`.
  app.get("/graph/v21.0/:id", (req, res) => {
    const fields = String(req.query.fields ?? "");
    const id = (req.params as any).id;
    if (fields.includes("permalink")) return res.json({ id, permalink: "https://www.instagram.com/p/MOCK123/" });
    if (fields.includes("status_code")) return res.json({ id, status_code: "FINISHED" });
    res.json({ id });
  });

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = (server.address() as any).port;
  selfOrigin = `http://127.0.0.1:${port}`;

  return {
    canvaBase: `${selfOrigin}/rest/v1`,
    igBase: `${selfOrigin}/graph/v21.0`,
    state,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
