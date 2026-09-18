import { startMocks } from "./mocks.js";
import { writeFixtures } from "./fixtures.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SP = writeFixtures();
const mod = (rel: string, bust = "") =>
  new URL(`../src/${rel}${bust}`, import.meta.url).href;
const img = (n: string) => `${SP}/${n}`;

const SQUARE = img("square_1080.jpg");
const PORTRAIT = img("portrait_1080x1350.jpg");
const TALL = img("too_tall_1080x1920.jpg");

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

// Mutable so one mock server can serve every scenario.
const mockOpts: { imagePaths: string[]; pollsBeforeSuccess?: number; exportFails?: { code: string; message: string } } = {
  imagePaths: [SQUARE],
  pollsBeforeSuccess: 3,
};

const mocks = await startMocks(mockOpts);

// Env must be in place before config.ts is first imported.
process.env.CANVA_CLIENT_ID = "mock-client";
process.env.CANVA_CLIENT_SECRET = "mock-secret";
process.env.CANVA_API_BASE = mocks.canvaBase;
process.env.IG_GRAPH_BASE = mocks.igBase;
process.env.IG_ACCESS_TOKEN = "mock-ig-token";
process.env.IG_USER_ID = "17841400000000000";
process.env.MEDIA_MODE = "canva";
process.env.LOG_LEVEL = "error";

const { publishDesignToInstagram } = await import(mod("publish/pipeline.ts"));
const reset = () => { mocks.state.containers.length = 0; mocks.state.fetchedImageUrls.length = 0;
                      mocks.state.imageBytesOk.length = 0; mocks.state.carouselChildren = undefined;
                      mocks.state.publishedCreationId = undefined; mocks.state.publishedCaption = undefined; };

const base = { canvaAccessToken: "mock-canva-token", designId: "DAGmock0001" };

/* ── 1. single image ─────────────────────────────────────────────── */
console.log("\n1. Single-image publish");
{
  reset(); mockOpts.imagePaths = [SQUARE]; mockOpts.exportFails = undefined;
  const r = await publishDesignToInstagram({ ...base, caption: "hello world" });
  ok("mode is single", r.mode === "single", r.mode);
  ok("polled the async export job", mocks.state.exportPolls >= 3, `${mocks.state.exportPolls} polls`);
  ok("one container staged", mocks.state.containers.length === 1);
  ok("Instagram fetched real JPEG bytes", mocks.state.imageBytesOk.every(Boolean));
  ok("caption forwarded", mocks.state.publishedCaption === "hello world", mocks.state.publishedCaption);
  ok("published the staged container", mocks.state.publishedCreationId === "container_0", String(mocks.state.publishedCreationId));
  ok("media id returned", r.mediaId === "media_mock_999");
  ok("permalink resolved", r.permalink === "https://www.instagram.com/p/MOCK123/");
  ok("dimensions measured", r.images[0]?.dimensions?.width === 1080);
  ok("quota reported", r.quota?.quotaUsage === 3);
}

/* ── 2. carousel ─────────────────────────────────────────────────── */
console.log("\n2. Multi-page auto-carousel");
{
  reset(); mockOpts.imagePaths = [SQUARE, PORTRAIT, SQUARE];
  const r = await publishDesignToInstagram({ ...base, caption: "swipe" });
  ok("mode is carousel", r.mode === "carousel", r.mode);
  ok("3 children + 1 carousel container", mocks.state.containers.length === 4, `${mocks.state.containers.length}`);
  ok("children wired to carousel", mocks.state.carouselChildren?.join(",") === "container_0,container_1,container_2",
     String(mocks.state.carouselChildren));
  ok("carousel container published", mocks.state.publishedCreationId === "carousel_3", String(mocks.state.publishedCreationId));
  ok("caption on the carousel", mocks.state.publishedCaption === "swipe");
  ok("all pages fetched as JPEG", mocks.state.imageBytesOk.length === 3 && mocks.state.imageBytesOk.every(Boolean));
}

/* ── 3. forced single from a multi-page design ───────────────────── */
console.log("\n3. mode=single on a 3-page design");
{
  reset();
  const r = await publishDesignToInstagram({ ...base, mode: "single" });
  ok("only page 1 published", mocks.state.containers.length === 1);
  ok("warned about dropped pages", r.warnings.some((w: string) => w.includes("publishing page 1 only")), r.warnings[0]);
}

/* ── 4. carousel cap at 10 ───────────────────────────────────────── */
console.log("\n4. 12-page design clamps to 10");
{
  reset(); mockOpts.imagePaths = Array(12).fill(SQUARE);
  const r = await publishDesignToInstagram({ ...base, mode: "carousel" });
  ok("exactly 10 children", mocks.state.carouselChildren?.length === 10, String(mocks.state.carouselChildren?.length));
  ok("warned about the cap", r.warnings.some((w: string) => w.includes("cap at 10")), r.warnings[0]);
}

/* ── 5. dry run ──────────────────────────────────────────────────── */
console.log("\n5. Dry run");
{
  reset(); mockOpts.imagePaths = [SQUARE];
  const r = await publishDesignToInstagram({ ...base, dryRun: true, caption: "nope" });
  ok("dryRun flagged", r.dryRun === true);
  ok("no Instagram calls at all", mocks.state.containers.length === 0 && !mocks.state.publishedCreationId);
  ok("image still exported + measured", r.images[0]?.aspectRatio === 1);
  ok("no media id", r.mediaId === undefined);
}

/* ── 6. aspect ratio gate ────────────────────────────────────────── */
console.log("\n6. Aspect-ratio pre-flight");
{
  reset(); mockOpts.imagePaths = [TALL];
  let threw = "";
  try { await publishDesignToInstagram({ ...base }); } catch (e) { threw = (e as Error).message; }
  ok("rejected a 9:16 design", threw.includes("too tall"), threw.slice(0, 70));
  ok("nothing was posted", mocks.state.containers.length === 0);

  reset();
  const r = await publishDesignToInstagram({ ...base, ignoreAspectRatio: true });
  ok("override publishes anyway", r.mediaId === "media_mock_999");
  ok("but warns", r.warnings.some((w: string) => w.includes("crop")), r.warnings[0]);
}

/* ── 7. export failure surfaces a readable message ───────────────── */
console.log("\n7. Canva export failure");
{
  reset(); mockOpts.imagePaths = [SQUARE];
  mockOpts.exportFails = { code: "license_required", message: "Premium element not licensed" };
  let threw = "";
  try { await publishDesignToInstagram({ ...base }); } catch (e) { threw = (e as Error).message; }
  ok("failure explained", threw.includes("license_required") && threw.includes("premium elements"), threw.slice(0, 90));
  ok("no Instagram calls", mocks.state.containers.length === 0);
  mockOpts.exportFails = undefined;
}

/* ── 8. caption length guard ─────────────────────────────────────── */
console.log("\n8. Caption limit");
{
  reset();
  let threw = "";
  try { await publishDesignToInstagram({ ...base, caption: "x".repeat(2201) }); } catch (e) { threw = (e as Error).message; }
  ok("2201 chars rejected before any API call", threw.includes("2200"), threw.slice(0, 60));
  ok("no export was even started", mocks.state.containers.length === 0);
}

/* ── 9. page subset ──────────────────────────────────────────────── */
console.log("\n9. Explicit page selection");
{
  reset(); mockOpts.imagePaths = [SQUARE, PORTRAIT];
  const r = await publishDesignToInstagram({ ...base, pages: [2, 3], mode: "carousel" });
  ok("page numbers echoed from the request", r.images.map((i: any) => i.page).join(",") === "2,3",
     r.images.map((i: any) => i.page).join(","));
}

/* ── 10. the local-URL guard itself ──────────────────────────────── */
console.log("\n10. PUBLIC_BASE_URL local-host guard");
{
  const { isLocalUrl } = await import(mod("config.ts", "?guard=1"));
  const cases: Array<[string, boolean]> = [
    ["http://127.0.0.1:3000", true], ["http://localhost:3000", true], ["http://0.0.0.0:3000", true],
    ["http://192.168.1.5", true], ["http://10.0.0.4", true], ["http://172.16.4.1", true],
    ["http://[::1]:3000", true], ["not a url", true],
    ["https://abc.ngrok-free.app", false], ["https://publisher.example.com", false],
    ["http://172.32.0.1", false],
  ];
  for (const [url, want] of cases) ok(`${url} local=${want}`, isLocalUrl(url) === want);
}

await mocks.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
