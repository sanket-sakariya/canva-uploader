/**
 * Headless publisher — no browser, no Canva editor.
 *
 *   npm run publish:cli -- --design DAGxxxxxxx --caption "Hello" [--dry-run]
 *   npm run publish:cli -- --list
 *
 * Requires a Canva token in .tokens.json (run the server once and visit
 * /auth/canva), plus IG_ACCESS_TOKEN in .env.
 */
import { parseArgs } from "node:util";
import { CanvaClient } from "./canva/client.js";
import { publishDesignToInstagram, type PublishMode } from "./publish/pipeline.js";
import { getValidAccessToken } from "./store/tokenStore.js";

const { values } = parseArgs({
  options: {
    design: { type: "string", short: "d" },
    caption: { type: "string", short: "c" },
    pages: { type: "string", short: "p" },
    mode: { type: "string", short: "m", default: "auto" },
    list: { type: "boolean", short: "l", default: false },
    query: { type: "string", short: "q" },
    "dry-run": { type: "boolean", default: false },
    "ignore-aspect-ratio": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: false,
});

const USAGE = `
Publish a Canva design straight to Instagram.

  --list, -l                 List your Canva designs and exit
  --query, -q <text>         Filter the list
  --design, -d <designId>    Canva design id (e.g. DAGxxxxxxx)
  --caption, -c <text>       Instagram caption (max 2200 chars)
  --pages, -p <1,2,3>        Which pages to export (default: all)
  --mode, -m <auto|single|carousel>
  --dry-run                  Export and validate, but don't post
  --ignore-aspect-ratio      Post even if Instagram will crop it
`;

async function main(): Promise<void> {
  if (values.help) {
    console.log(USAGE);
    return;
  }

  const accessToken = await getValidAccessToken();

  if (values.list) {
    const { items } = await new CanvaClient(accessToken).listDesigns({ query: values.query, limit: 50 });
    if (!items.length) {
      console.log("No designs found.");
      return;
    }
    for (const d of items) {
      const pages = d.page_count ?? 1;
      console.log(`${d.id.padEnd(14)} ${String(pages).padStart(2)}p  ${d.title ?? "(untitled)"}`);
    }
    return;
  }

  if (!values.design) {
    console.error("Missing --design. Run with --list to see your design ids.\n" + USAGE);
    process.exitCode = 1;
    return;
  }

  const pages = values.pages
    ?.split(",")
    .map((p) => Number.parseInt(p.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0);

  const report = await publishDesignToInstagram({
    canvaAccessToken: accessToken,
    designId: values.design,
    caption: values.caption,
    pages: pages?.length ? pages : undefined,
    mode: values.mode as PublishMode,
    dryRun: values["dry-run"],
    ignoreAspectRatio: values["ignore-aspect-ratio"],
    onProgress: ({ step, detail }) => console.log(`  ${step}${detail ? ` — ${detail}` : ""}`),
  });

  console.log("");
  for (const w of report.warnings) console.log(`  warning: ${w}`);
  if (report.dryRun) {
    console.log(`Dry run OK — ${report.images.length} image(s) ready, nothing posted.`);
    for (const img of report.images) {
      console.log(`  page ${img.page}: ${img.dimensions?.width}x${img.dimensions?.height} (${img.aspectRatio}:1)`);
    }
  } else {
    console.log(`Published as ${report.mode}. Media id ${report.mediaId}`);
    if (report.permalink) console.log(`  ${report.permalink}`);
    if (report.quota) console.log(`  quota: ${report.quota.quotaUsage + 1}/${report.quota.quotaTotal} in 24h`);
  }
  console.log(`Took ${(report.elapsedMs / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error(`\nFailed: ${(err as Error).message}`);
  process.exitCode = 1;
});
