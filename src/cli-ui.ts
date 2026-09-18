/**
 * Post through Canva's own Share → Instagram flow, using the Meta connection
 * already linked inside your Canva account. No Instagram API token involved.
 *
 *   npm run canva:login
 *   npm run canva:post -- --design DAGxxxxxxxxx --caption "hello" --dry-run
 *   npm run canva:post -- --design DAGxxxxxxxxx --caption "hello"
 *   npm run canva:post -- --design DAGxxxxxxxxx --inspect
 */
import { parseArgs } from "node:util";
import { log } from "./lib/logger.js";
import { DEBUG_DIR, isLoggedIn, openContext, PROFILE_DIR, snap } from "./canva-ui/session.js";
import { inspect, publishViaCanvaUi, StepError } from "./canva-ui/publisher.js";

const { values, positionals } = parseArgs({
  options: {
    design: { type: "string", short: "d" },
    caption: { type: "string", short: "c" },
    platform: { type: "string", short: "p", default: "Instagram" },
    "dry-run": { type: "boolean", default: false },
    inspect: { type: "boolean", default: false },
    headless: { type: "boolean", default: false },
    slow: { type: "string", default: "0" },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: true,
});

const USAGE = `
Post via Canva's own share flow (uses your existing Canva ↔ Instagram link).

  login                      Open a browser so you can sign in to Canva once
  post                       Drive Share → Instagram for a design

  --design,  -d <id>         Canva design id (e.g. DAGxxxxxxxxx)
  --caption, -c <text>       Caption to type into Canva's share panel
  --platform,-p <name>       Share target label (default: Instagram)
  --dry-run                  Walk the flow but never click the final Publish
  --inspect                  Open the share menu and list what Canva renders
  --headless                 Run without a visible window (not recommended)
  --slow <ms>                Slow each action down, useful for watching it work

Screenshots of every step are written to .canva-debug/
`;

async function main(): Promise<void> {
  const command = positionals[0] ?? (values.design ? "post" : "help");
  if (values.help || command === "help") {
    console.log(USAGE);
    return;
  }

  const slowMo = Number.parseInt(values.slow ?? "0", 10) || 0;

  // Measured, not guessed: canva.com answers headless Chrome with a Cloudflare
  // interstitial (HTTP 403, "Just a moment..."), and serves a headed window
  // normally (HTTP 200). So this flow needs a real display.
  if (values.headless) {
    log.warn("Canva blocks headless browsers with a Cloudflare challenge — this will almost certainly fail.");
    log.warn("Drop --headless and run it on a machine with a display.");
  }
  if (!values.headless && !process.env.DISPLAY && process.platform === "linux") {
    console.error("\nNo DISPLAY detected. This flow drives a visible Chrome window and cannot run headless");
    console.error("(Canva serves a Cloudflare bot wall to headless browsers). Run it on a desktop session.\n");
    process.exitCode = 1;
    return;
  }

  if (command === "login") {
    const context = await openContext({ headless: false, slowMo });
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto("https://www.canva.com/login", { waitUntil: "domcontentloaded" });

    console.log("\n  A browser window is open.");
    console.log("  Sign in to Canva there — including any 2FA.");
    console.log("  This window is a normal Chrome profile stored in:");
    console.log(`    ${PROFILE_DIR}`);
    console.log("\n  Waiting for you to finish (up to 5 minutes)…\n");

    const deadline = Date.now() + 5 * 60_000;
    let ok = false;
    while (Date.now() < deadline) {
      await page.waitForTimeout(5_000);
      if (!/\/login|\/signup/.test(page.url())) {
        ok = await isLoggedIn(page);
        if (ok) break;
      }
    }
    await snap(page, ok ? "logged-in" : "login-timeout");
    console.log(ok ? "  Signed in. The session persists — you won't need this again soon." : "  Timed out. Run it again.");
    await context.close();
    process.exitCode = ok ? 0 : 1;
    return;
  }

  if (command !== "post") {
    console.error(`Unknown command "${command}".\n${USAGE}`);
    process.exitCode = 1;
    return;
  }

  if (!values.design) {
    console.error(`Missing --design.\n${USAGE}`);
    process.exitCode = 1;
    return;
  }

  const context = await openContext({ headless: values.headless, slowMo });
  const page = context.pages()[0] ?? (await context.newPage());

  try {
    if (!(await isLoggedIn(page))) {
      console.error("\nNot signed in to Canva. Run:  npm run canva:login\n");
      process.exitCode = 1;
      return;
    }
    log.info("Canva session is live");

    if (values.inspect) {
      await page.goto(`https://www.canva.com/design/${values.design}/edit`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await page.waitForTimeout(8_000);
      await snap(page, "inspect-editor");
      const controls = await inspect(page);
      console.log(`\n--- ${controls.length} visible controls in the editor ---`);
      for (const c of controls) console.log("  " + c);
      console.log(`\nScreenshots: ${DEBUG_DIR}`);
      return;
    }

    const result = await publishViaCanvaUi(page, {
      designId: values.design,
      caption: values.caption,
      dryRun: values["dry-run"],
      platform: values.platform,
    });

    console.log("");
    console.log(
      result.dryRun
        ? `Dry run finished — reached the confirm step for ${result.platform} without clicking it.`
        : `Publish clicked for ${result.platform}. Check the Instagram account to confirm it landed.`,
    );
    console.log(`Screenshots (${result.screenshots.length}): ${DEBUG_DIR}`);
  } catch (err) {
    if (err instanceof StepError) {
      console.error(`\nFailed at step "${err.step}": ${err.message}`);
      if (err.screenshot) console.error(`Screenshot: ${err.screenshot}`);
      console.error(`\nCanva's DOM has no API contract, so a renamed control breaks a step.`);
      console.error(`Run with --inspect to see the current labels, then pass --platform if needed.`);
    } else {
      console.error(`\nFailed: ${(err as Error).message}`);
    }
    process.exitCode = 1;
  } finally {
    if (!values.headless) await page.waitForTimeout(2_500);
    await context.close();
  }
}

main().catch((err) => {
  console.error(`\nFailed: ${(err as Error).message}`);
  process.exitCode = 1;
});
