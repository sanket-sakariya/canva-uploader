/**
 * MEDIA_MODE=proxy has to run in its own process: config.ts snapshots the
 * environment on first import, which is exactly what the server does at boot.
 */
import express from "express";
import type { Router } from "express";
import { startMocks } from "./mocks.js";
import { writeFixtures } from "./fixtures.js";

const SP = writeFixtures();
let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const mockOpts = { imagePaths: [`${SP}/square_1080.jpg`], pollsBeforeSuccess: 1 };
const mocks = await startMocks(mockOpts);

// Bind the port before config is read, but mount the real router afterwards.
let router: Router | null = null;
const app = express();
app.use("/media", (req, res, next) => (router ? router(req, res, next) : res.status(503).end()));
const srv = await new Promise<any>((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
const port = srv.address().port;

process.env.CANVA_CLIENT_ID = "mock-client";
process.env.CANVA_CLIENT_SECRET = "mock-secret";
process.env.CANVA_API_BASE = mocks.canvaBase;
process.env.IG_GRAPH_BASE = mocks.igBase;
process.env.IG_ACCESS_TOKEN = "mock-ig-token";
process.env.IG_USER_ID = "17841400000000000";
process.env.MEDIA_MODE = "proxy";
process.env.PUBLIC_BASE_URL = `http://0.0.0.0:${port}`;
process.env.ALLOW_LOCAL_PUBLIC_URL = "1";
process.env.LOG_LEVEL = "error";

router = (await import("../src/routes/media.js")).mediaRouter;
const { publishDesignToInstagram } = await import("../src/publish/pipeline.js");
const { config } = await import("../src/config.js");

console.log("\nMEDIA_MODE=proxy re-hosting");
ok("config picked up proxy mode", config.mediaMode === "proxy", config.mediaMode);

const r = await publishDesignToInstagram({
  canvaAccessToken: "mock-canva-token",
  designId: "DAGmock0001",
  caption: "via proxy",
});

const delivered = r.images[0]!.deliveredUrl;
ok("delivered URL is ours, not Canva's", delivered.startsWith(`http://0.0.0.0:${port}/media/`), delivered);
ok("URL ends in .jpg", delivered.endsWith(".jpg"));
ok("Instagram fetched it from us", mocks.state.fetchedImageUrls[0] === delivered, mocks.state.fetchedImageUrls[0]);
ok("and got valid JPEG bytes back", mocks.state.imageBytesOk[0] === true);
ok("published", r.mediaId === "media_mock_999");

// An unknown id must 404 rather than serve something stale.
const miss = await fetch(`http://127.0.0.1:${port}/media/00000000-0000-0000-0000-000000000000.jpg`);
ok("unknown media id 404s", miss.status === 404, String(miss.status));

srv.close();
await mocks.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
