/**
 * Preflight: answers "is my setup actually going to work?" before you click
 * anything. Validates the Canva client pair against the real token endpoint,
 * reports stored-token state, and checks the Instagram token if one is set.
 *
 *   npm run doctor
 */
import "dotenv/config";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "./config.js";
import { buildAuthorizeUrl } from "./canva/oauth.js";
import { InstagramClient } from "./instagram/client.js";
import * as tokens from "./store/tokenStore.js";

const OK = "\x1b[32m✓\x1b[0m";
const BAD = "\x1b[31m✗\x1b[0m";
const WARN = "\x1b[33m!\x1b[0m";

let problems = 0;

function line(sym: string, label: string, detail = ""): void {
  console.log(`  ${sym} ${label}${detail ? `  ${detail}` : ""}`);
}

function mask(secret: string): string {
  return secret.length > 14 ? `${secret.slice(0, 9)}…${secret.slice(-4)}` : "…";
}

console.log("\nCanva → Instagram · preflight\n");

/* ── env file ─────────────────────────────────────────────────────── */
console.log("Environment");
if (existsSync(resolve(process.cwd(), ".env"))) line(OK, ".env found");
else {
  line(BAD, ".env missing", "run: cp .env.example .env");
  problems++;
}

/* ── Canva credentials ────────────────────────────────────────────── */
console.log("\nCanva integration");
let clientId = "";
let clientSecret = "";
try {
  clientId = config.canva.clientId;
  clientSecret = config.canva.clientSecret;
  line(OK, "client id", clientId);
  line(OK, "client secret", `${mask(clientSecret)} (${clientSecret.length} chars)`);
} catch (err) {
  line(BAD, "credentials", (err as Error).message);
  problems++;
}

line(OK, "redirect uri", config.canva.redirectUri);
line(OK, "scopes requested", config.canva.scopes.join(" "));

if (clientId && clientSecret) {
  // A deliberately invalid code separates "bad client" from "bad code":
  // invalid_client means Canva rejects the pair, invalid_grant means it
  // accepted the pair and only objected to the code — which is what we want.
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  try {
    const res = await fetch(config.canva.tokenUrl, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: "preflight-invalid-code",
        code_verifier: "x".repeat(64),
        redirect_uri: config.canva.redirectUri,
      }).toString(),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };

    if (body.error === "invalid_grant") {
      line(OK, "credentials accepted by Canva", "(test code rejected, as expected)");
    } else if (body.error === "invalid_client" || res.status === 401) {
      line(BAD, "Canva rejected this client id / secret pair", `HTTP ${res.status}`);
      console.log("      Check both values in the Developer Portal → Configuration.");
      console.log("      The secret is shown only once — regenerate it if you no longer have it.");
      problems++;
    } else {
      line(WARN, "unexpected reply from Canva", `HTTP ${res.status} ${JSON.stringify(body).slice(0, 120)}`);
    }
  } catch (err) {
    line(WARN, "could not reach Canva", (err as Error).message);
  }
}

/* ── stored token ─────────────────────────────────────────────────── */
console.log("\nCanva authorization");
const stored = await tokens.load();
if (!stored) {
  line(WARN, "not connected yet", "open the URL below once the server is running");
} else if (tokens.isExpired(stored)) {
  line(OK, "connected", "token expired — it refreshes automatically on next use");
} else {
  const mins = Math.round((stored.expiresAt - Date.now()) / 60_000);
  line(OK, "connected", `token valid for ~${mins} min · scopes: ${stored.scope}`);
}

/* ── Instagram ────────────────────────────────────────────────────── */
console.log("\nInstagram");
if (!config.instagram.accessToken) {
  line(WARN, "IG_ACCESS_TOKEN not set", "dry runs work; publishing is disabled");
} else {
  line(OK, "graph host", config.instagram.base);
  try {
    const account = config.instagram.userId
      ? { id: config.instagram.userId, username: undefined as string | undefined }
      : await InstagramClient.discoverAccount(config.instagram.accessToken);
    line(OK, "account", `${account.username ? "@" + account.username + " " : ""}${account.id}`);
    const ig = new InstagramClient(config.instagram.accessToken, account.id);
    const quota = await ig.getPublishingLimit();
    if (quota) line(OK, "daily quota", `${quota.quotaUsage}/${quota.quotaTotal} used in the last 24h`);
  } catch (err) {
    line(BAD, "token check failed", (err as Error).message);
    // The commonest setup mistake is pairing an Instagram-Login token with the
    // Facebook graph host (or vice versa). Try the other one and say so.
    const other =
      config.instagram.host === "graph.instagram.com" ? "graph.facebook.com" : "graph.instagram.com";
    const worked = await probeHost(other, config.instagram.accessToken);
    if (worked) {
      line(WARN, "but the token DOES work against " + other, worked);
      console.log(`      Fix: set IG_GRAPH_HOST=${other} in .env`);
    } else {
      console.log("      Check the account is Business/Creator and the token carries");
      console.log("      instagram_business_content_publish (or instagram_content_publish).");
    }
    problems++;
  }
}

/** Returns a description of the account if this host accepts the token. */
async function probeHost(host: string, token: string): Promise<string | null> {
  const v = config.instagram.version;
  try {
    if (host === "graph.instagram.com") {
      const r = await fetch(
        `https://${host}/${v}/me?fields=user_id,username&access_token=${encodeURIComponent(token)}`,
      );
      const j = (await r.json()) as { user_id?: string; id?: string; username?: string };
      if (!r.ok || !(j.user_id ?? j.id)) return null;
      return `${j.username ? "@" + j.username + " " : ""}${j.user_id ?? j.id}`;
    }
    const r = await fetch(
      `https://${host}/${v}/me/accounts?fields=name,instagram_business_account{id,username}&access_token=${encodeURIComponent(token)}`,
    );
    const j = (await r.json()) as { data?: Array<{ instagram_business_account?: { id: string; username?: string } }> };
    const hit = j.data?.find((p) => p.instagram_business_account?.id)?.instagram_business_account;
    return hit ? `${hit.username ? "@" + hit.username + " " : ""}${hit.id}` : null;
  } catch {
    return null;
  }
}

/* ── media delivery ───────────────────────────────────────────────── */
console.log("\nMedia delivery");
line(OK, "mode", config.mediaMode);
if (config.mediaMode === "proxy") {
  const { isLocalUrl } = await import("./config.js");
  if (isLocalUrl(config.publicBaseUrl) && !config.allowLocalPublicUrl) {
    line(BAD, "PUBLIC_BASE_URL is not reachable by Instagram", config.publicBaseUrl);
    problems++;
  } else line(OK, "public base url", config.publicBaseUrl);
}

/* ── what to do next ──────────────────────────────────────────────── */
console.log("\nNext step");
if (!stored) {
  console.log(`  Start the server:  npm run dev`);
  console.log(`  Then open:         http://127.0.0.1:${config.port}`);
  console.log(`\n  Make sure this exact redirect URL is registered in the Developer Portal:`);
  console.log(`    ${config.canva.redirectUri}`);
  try {
    console.log(`\n  (direct authorize link, if you'd rather skip the UI:)`);
    console.log(`    ${buildAuthorizeUrl().url.slice(0, 110)}…`);
  } catch { /* credentials already reported above */ }
} else {
  console.log(`  npm run dev  →  http://127.0.0.1:${config.port}`);
  console.log(`  or headless:  npm run publish:cli -- --list`);
}

console.log(problems ? `\n\x1b[31m${problems} problem(s) found.\x1b[0m\n` : "\n\x1b[32mAll checks passed.\x1b[0m\n");
process.exit(problems ? 1 : 0);
