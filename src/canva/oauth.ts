import { config } from "../config.js";
import { requestJson } from "../lib/http.js";
import { createPkce, randomState, type Pkce } from "../lib/pkce.js";
import type { CanvaTokenResponse } from "./types.js";

export interface AuthStart {
  url: string;
  state: string;
  pkce: Pkce;
}

/** Builds the Canva consent URL. The verifier must never leave the server. */
export function buildAuthorizeUrl(): AuthStart {
  const pkce = createPkce();
  const state = randomState();
  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.canva.clientId,
    redirect_uri: config.canva.redirectUri,
    scope: config.canva.scopes.join(" "),
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    state,
  });
  return { url: `${config.canva.authorizeUrl}?${params}`, state, pkce };
}

function basicAuthHeader(): string {
  const creds = `${config.canva.clientId}:${config.canva.clientSecret}`;
  return `Basic ${Buffer.from(creds).toString("base64")}`;
}

async function tokenRequest(body: URLSearchParams): Promise<CanvaTokenResponse> {
  return requestJson<CanvaTokenResponse>(config.canva.tokenUrl, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
    // A failed token exchange is not worth hammering — the code is single-use.
    retries: 1,
  });
}

export function exchangeCode(code: string, codeVerifier: string): Promise<CanvaTokenResponse> {
  return tokenRequest(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: codeVerifier,
      redirect_uri: config.canva.redirectUri,
    }),
  );
}

/** Canva refresh tokens are single-use — the response always rotates both. */
export function refreshAccessToken(refreshToken: string): Promise<CanvaTokenResponse> {
  return tokenRequest(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  );
}
