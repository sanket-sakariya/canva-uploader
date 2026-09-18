/**
 * Drives the actual web UI in a browser: paste cookies → Open → the discovered
 * platforms must appear as clickable options → pick one → the connected account
 * must be shown. Stops before uploading.
 *
 *   CANVA_COOKIES=/path/to/cookies.txt npx tsx tests/ui-smoke.test.ts
 *   CANVA_EMAIL=… CANVA_PASSWORD=… npx tsx tests/ui-smoke.test.ts
 *
 * Whichever pair of credentials is present selects the auth tab under test.
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const BASE = process.env.APP_URL ?? "http://127.0.0.1:3000";
const COOKIES_FILE = process.env.CANVA_COOKIES;
const DESIGN = process.env.DESIGN_ID ?? "DAGxxxxxxxxx";
const SHOTS = resolve(process.cwd(), ".canva-debug");

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const EMAIL = process.env.CANVA_EMAIL;
const PASSWORD = process.env.CANVA_PASSWORD;
const MODE = COOKIES_FILE ? "cookies" : EMAIL && PASSWORD ? "password" : null;

if (!MODE) {
  console.error("Set CANVA_COOKIES=/path/to/cookies.txt, or CANVA_EMAIL + CANVA_PASSWORD");
  process.exit(2);
}
console.log(`  auth mode under test: ${MODE}`);

const browser = await chromium.launch({ headless: true, channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1100, height: 1400 } });

await page.goto(BASE, { waitUntil: "domcontentloaded" });
ok("app page loads", (await page.title()).length > 0, await page.title());

// Step 2 must start locked.
ok("step 2 starts disabled", await page.locator("#box2").evaluate((el) => el.classList.contains("off")));

// The auth tabs must actually swap the panes.
ok("cookie pane visible by default", !(await page.locator("#paneCookies").isHidden()));
await page.click("#tabPassword");
ok("password tab reveals its pane", await page.locator("#paneCookies").isHidden());
ok("password fields present", (await page.locator("#canvaEmail").count()) === 1);
await page.click("#tabCookies");
ok("switching back restores the cookie pane", !(await page.locator("#paneCookies").isHidden()));

if (MODE === "cookies") {
  await page.fill("#cookies", readFileSync(COOKIES_FILE!, "utf8"));
  await page.click("#checkCookiesBtn");
  await page.waitForTimeout(1_500);
  const cookieStatus = (await page.textContent("#cookieStatus")) ?? "";
  ok("cookie check reports a session", cookieStatus.includes("✓"), cookieStatus.slice(0, 60));
} else {
  await page.click("#tabPassword");
  await page.fill("#canvaEmail", EMAIL!);
  await page.fill("#canvaPassword", PASSWORD!);
  ok("credentials entered", (await page.inputValue("#canvaEmail")) === EMAIL);
}
await page.fill("#uiDesign", DESIGN);

console.log("\n  opening Canva (this launches a real Chrome window, ~40s)…");
await page.click("#openBtn");

// A 2FA prompt stops the run rather than hanging on a code nobody can supply.
const twoFactor = await Promise.race([
  page.waitForSelector("#paneCode:not(.hide)", { timeout: 120_000 }).then(() => true).catch(() => false),
  page.waitForSelector("#platforms button", { timeout: 120_000 }).then(() => false).catch(() => false),
]);
if (twoFactor) {
  console.log(`\n  Canva asked for a verification code: ${await page.textContent("#codeMsg")}`);
  console.log("  Can't continue unattended — enter it in the UI by hand.");
  await browser.close();
  process.exit(0);
}

// The platform buttons are the thing under test.
await page.waitForSelector("#platforms button", { timeout: 180_000 }).catch(() => {});
const labels = await page.locator("#platforms button").allTextContents();
ok("platform options rendered in the frontend", labels.length > 0, labels.join(", "));
ok("Instagram offered as an option", labels.some((l) => /instagram/i.test(l)));
ok("step 2 unlocked", !(await page.locator("#box2").evaluate((el) => el.classList.contains("off"))));
ok("step 1 marked done", await page.locator("#box1").evaluate((el) => el.classList.contains("done")));
await page.screenshot({ path: `${SHOTS}/ui-01-platforms.png` });

// Pick one and confirm the account surfaces.
const igBtn = page.locator("#platforms button", { hasText: /instagram/i }).first();
await igBtn.click();
await page.waitForFunction(
  () => (document.querySelector("#accountBox")?.textContent ?? "").trim().length > 0,
  { timeout: 180_000 },
).catch(() => {});
const acct = ((await page.textContent("#accountBox")) ?? "").trim();
ok("connected account shown after picking", /will post as/i.test(acct), acct.slice(0, 70));
ok("chosen platform highlighted", await igBtn.evaluate((el) => el.classList.contains("sel")));

// The account chooser must offer the connected account(s) as options.
const acctLabels = await page.locator("#accounts button").allTextContents();
ok("account options rendered", acctLabels.length > 0, acctLabels.join(", "));
ok("an account is preselected", (await page.locator("#accounts button.sel").count()) === 1);
ok("account hint describes the choice", /post as/i.test((await page.textContent("#accountHint")) ?? ""));
ok("step 3 unlocked", !(await page.locator("#box3").evaluate((el) => el.classList.contains("off"))));
await page.screenshot({ path: `${SHOTS}/ui-02-account.png` });

// Clean up the live Canva session the UI opened. The Close button lives in
// step 4, which is still pointer-events:none at this point, so close via the
// API instead of clicking it.
const open = await fetch(`${BASE}/api/canva-ui/sessions`).then((r) => r.json());
for (const s of open.sessions ?? []) {
  await fetch(`${BASE}/api/canva-ui/${s.id}/close`, { method: "POST" }).catch(() => {});
}
const left = await fetch(`${BASE}/api/canva-ui/sessions`).then((r) => r.json());
ok("no browser sessions left open", (left.sessions ?? []).length === 0, `${(left.sessions ?? []).length} open`);

await browser.close();
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
