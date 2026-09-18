/**
 * Signs in to Canva with an email and password, as an alternative to pasting
 * cookies.
 *
 * Canva's default is passwordless — it emails a 6-digit code — so a password
 * isn't always enough. This handles both: it uses the password when Canva
 * offers that path, and otherwise reports `need-code` so the caller can ask the
 * user for the code Canva just emailed and feed it back in.
 *
 * Selectors below were read off the live login page rather than guessed:
 *   "Continue with email" → input[name="username"] → button[type="submit"]
 */
import type { Page } from "playwright";
import { log } from "../lib/logger.js";
import { firstVisible, allFramesText } from "./locate.js";
import { snap } from "./session.js";

export type LoginState = "success" | "need-code" | "error";

/** Where the second factor comes from — they read very differently to a user. */
export type CodeSource = "authenticator" | "email" | "unknown";

export interface LoginResult {
  state: LoginState;
  /** Human-readable detail — the reason for an error, or what Canva is asking. */
  detail?: string;
  /** Set when state is "need-code". */
  codeSource?: CodeSource;
}

const EMAIL_INPUT = 'input[name="username"]';

/** Canva sometimes lands on a chooser before showing the email form. */
async function chooseEmailPath(page: Page): Promise<void> {
  const choose = await firstVisible(
    [
      page.getByRole("button", { name: /continue with email/i }),
      page.getByRole("button", { name: /log in with email/i }),
      page.getByRole("link", { name: /continue with email/i }),
    ],
    6_000,
  );
  if (choose) {
    await choose.click();
    await page.waitForTimeout(2_500);
    return;
  }
  // Already past the chooser, or Canva showed "Continue another way" first.
  const another = await firstVisible([page.getByRole("button", { name: /continue another way/i })], 2_000);
  if (another) {
    await another.click();
    await page.waitForTimeout(2_000);
    const nested = await firstVisible([page.getByRole("button", { name: /continue with email/i })], 4_000);
    if (nested) {
      await nested.click();
      await page.waitForTimeout(2_500);
    }
  }
}

/**
 * Canva silently turns an unknown email into a signup. Catch that, because the
 * useful message is "no account for this email", not "unexpected screen".
 */
async function isSignupScreen(page: Page): Promise<boolean> {
  const text = await allFramesText(page).catch(() => "");
  return /creating a canva account|create your account|choose a different signup method/i.test(text);
}

/**
 * Distinguishes a TOTP prompt from an emailed code. Worth doing: telling someone
 * to "check your email" when Canva wants their authenticator app sends them
 * hunting for a message that will never arrive.
 */
export async function detectCodeSource(page: Page): Promise<CodeSource> {
  const text = await allFramesText(page).catch(() => "");
  if (/authenticator app|authentication app|two-factor|2fa|backup code/i.test(text)) return "authenticator";
  if (/we sent|check your (email|inbox)|sent (you )?a code|emailed/i.test(text)) return "email";
  return "unknown";
}

function codeMessage(source: CodeSource): string {
  if (source === "authenticator") {
    return "Canva wants your two-factor code. Open your authenticator app and enter the 6 digits it currently shows (they rotate every 30 seconds).";
  }
  if (source === "email") {
    return "Canva emailed you a verification code. Enter it to finish signing in.";
  }
  return "Canva is asking for a verification code. Enter it to finish signing in.";
}

/** Reads whichever prompt Canva is showing after the email is submitted. */
async function classifyPrompt(page: Page): Promise<"password" | "code" | "unknown"> {
  const pwd = page.locator('input[type="password"]').first();
  if ((await pwd.count().catch(() => 0)) > 0 && (await pwd.isVisible().catch(() => false))) return "password";

  const text = await allFramesText(page).catch(() => "");
  if (/enter the code|verification code|we sent|check your (email|inbox)|6-digit|authenticator app|backup code/i.test(text)) {
    return "code";
  }

  const codeBox = await firstVisible(
    [
      page.getByRole("textbox", { name: /code/i }),
      page.locator('input[autocomplete="one-time-code"]'),
      page.locator('input[inputmode="numeric"]'),
    ],
    1_500,
  );
  return codeBox ? "code" : "unknown";
}

/**
 * Drives the email → password flow. Returns `need-code` when Canva insists on
 * emailing a code instead; call {@link submitCode} with it afterwards.
 */
export async function loginWithPassword(
  page: Page,
  email: string,
  password: string,
  onProgress: (step: string, detail?: string) => void = () => {},
): Promise<LoginResult> {
  onProgress("Opening Canva login");
  await page.goto("https://www.canva.com/login", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(5_000);

  if (/just a moment/i.test(await page.title().catch(() => ""))) {
    return { state: "error", detail: "Cloudflare challenged the browser. Retry, or use the cookie method." };
  }

  await chooseEmailPath(page);
  await snap(page, "login-email-form");

  const emailBox = await firstVisible(
    [page.locator(EMAIL_INPUT), page.getByPlaceholder(/phone number or email|email/i)],
    10_000,
  );
  if (!emailBox) return { state: "error", detail: "Could not find Canva's email field." };

  onProgress("Entering email", email);
  await emailBox.fill(email);

  const cont = await firstVisible(
    [page.locator('button[type="submit"]'), page.getByRole("button", { name: /^continue$/i })],
    5_000,
  );
  if (!cont) return { state: "error", detail: "Could not find the Continue button." };
  await cont.click();
  await page.waitForTimeout(6_000);
  await snap(page, "login-after-email");

  if (await isSignupScreen(page)) {
    return {
      state: "error",
      detail: `Canva has no account for ${email} — it switched to the signup flow. Check the address, or sign in with cookies instead.`,
    };
  }

  // Canva may offer a password path behind a link when it defaults to a code.
  let prompt = await classifyPrompt(page);
  if (prompt !== "password") {
    const usePassword = await firstVisible(
      [
        page.getByRole("button", { name: /(log ?in|sign ?in|continue) with password|use password/i }),
        page.getByRole("link", { name: /password/i }),
      ],
      3_000,
    );
    if (usePassword) {
      onProgress("Switching to password sign-in");
      await usePassword.click();
      await page.waitForTimeout(3_000);
      prompt = await classifyPrompt(page);
    }
  }

  if (prompt === "code") {
    const source = await detectCodeSource(page);
    onProgress("Canva wants a verification code", source);
    return { state: "need-code", codeSource: source, detail: codeMessage(source) };
  }

  if (prompt !== "password") {
    const text = (await allFramesText(page).catch(() => "")).slice(0, 300).replace(/\s+/g, " ");
    return { state: "error", detail: `Canva showed an unexpected screen after the email: "${text}"` };
  }

  onProgress("Entering password");
  const pwdBox = page.locator('input[type="password"]').first();
  await pwdBox.fill(password);

  const submit = await firstVisible(
    [
      page.locator('button[type="submit"]'),
      page.getByRole("button", { name: /^(log ?in|continue|sign ?in)$/i }),
    ],
    5_000,
  );
  if (!submit) return { state: "error", detail: "Could not find the password submit button." };
  await submit.click();
  await page.waitForTimeout(8_000);
  await snap(page, "login-after-password");

  return afterCredentials(page, onProgress);
}

/** Submits the 6-digit code Canva emailed. */
export async function submitCode(
  page: Page,
  code: string,
  onProgress: (step: string, detail?: string) => void = () => {},
): Promise<LoginResult> {
  onProgress("Entering verification code");

  // Canva uses either one field or six single-character boxes.
  const boxes = page.locator('input[autocomplete="one-time-code"], input[inputmode="numeric"]');
  const count = await boxes.count().catch(() => 0);

  if (count > 1) {
    const digits = code.replace(/\D/g, "").split("");
    for (let i = 0; i < Math.min(count, digits.length); i++) {
      await boxes.nth(i).fill(digits[i]!);
      await page.waitForTimeout(120);
    }
  } else {
    const single = await firstVisible(
      [boxes, page.getByRole("textbox", { name: /code/i }), page.locator('input[type="text"]')],
      6_000,
    );
    if (!single) return { state: "error", detail: "Could not find the verification-code field." };
    await single.fill(code.replace(/\D/g, ""));
  }

  const submit = await firstVisible(
    [page.locator('button[type="submit"]'), page.getByRole("button", { name: /^(continue|verify|log ?in)$/i })],
    4_000,
  );
  if (submit) await submit.click();
  else await page.keyboard.press("Enter");

  await page.waitForTimeout(8_000);
  await snap(page, "login-after-code");
  return afterCredentials(page, onProgress);
}

/** Shared tail: did we actually end up signed in? */
async function afterCredentials(
  page: Page,
  onProgress: (step: string, detail?: string) => void,
): Promise<LoginResult> {
  if (await isSignupScreen(page)) {
    return { state: "error", detail: "Canva switched to the signup flow — that email has no Canva account." };
  }

  const text = await allFramesText(page).catch(() => "");

  if (/incorrect|wrong password|doesn'?t match|invalid|try again/i.test(text)) {
    const m = text.match(/.{0,80}(incorrect|wrong password|doesn'?t match|invalid).{0,80}/i);
    return { state: "error", detail: m?.[0]?.replace(/\s+/g, " ").trim() ?? "Canva rejected the credentials." };
  }
  if (await classifyPrompt(page).then((p) => p === "code")) {
    const source = await detectCodeSource(page);
    onProgress("Canva wants a verification code", source);
    return { state: "need-code", codeSource: source, detail: codeMessage(source) };
  }
  if (/\/login|\/signup/.test(page.url())) {
    return { state: "error", detail: "Still on the login page — sign-in did not complete." };
  }

  log.info("Signed in to Canva with email + password");
  return { state: "success" };
}
