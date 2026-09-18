import "dotenv/config";

function req(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing required env var ${name}. Copy .env.example to .env and fill it in.`);
  return v;
}

function opt(name: string, fallback: string): string {
  const v = process.env[name]?.trim();
  return v ? v : fallback;
}

function int(name: string, fallback: number): number {
  const v = process.env[name]?.trim();
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`env var ${name} must be an integer, got "${v}"`);
  return n;
}

export type MediaMode = "canva" | "proxy";
export type TokenStoreMode = "server" | "browser";

export const config = {
  port: int("PORT", 3000),
  logLevel: opt("LOG_LEVEL", "info"),

  canva: {
    // Lazy: the CLI can publish with an already-stored token, and `--help`
    // should never demand credentials just to print itself.
    get clientId(): string {
      return req("CANVA_CLIENT_ID");
    },
    get clientSecret(): string {
      return req("CANVA_CLIENT_SECRET");
    },
    redirectUri: opt("CANVA_REDIRECT_URI", "http://127.0.0.1:3000/auth/canva/callback"),
    // Overridable so the suite can run against a mock (and any future sandbox).
    apiBase: opt("CANVA_API_BASE", "https://api.canva.com/rest/v1"),
    authorizeUrl: opt("CANVA_AUTHORIZE_URL", "https://www.canva.com/api/oauth/authorize"),
    tokenUrl: opt("CANVA_TOKEN_URL", "https://api.canva.com/rest/v1/oauth/token"),
    // Exactly what this app calls, nothing more: listing designs needs
    // design:meta:read, exporting them needs design:content:read. Requesting a
    // scope that isn't enabled in the Developer Portal fails the authorization.
    scopes: ["design:meta:read", "design:content:read"],
  },

  instagram: {
    host: opt("IG_GRAPH_HOST", "graph.facebook.com"),
    version: opt("IG_GRAPH_VERSION", "v21.0"),
    /** Full base URL. Derived from host+version unless explicitly overridden. */
    base: opt(
      "IG_GRAPH_BASE",
      `https://${opt("IG_GRAPH_HOST", "graph.facebook.com")}/${opt("IG_GRAPH_VERSION", "v21.0")}`,
    ),
    accessToken: process.env.IG_ACCESS_TOKEN?.trim() ?? "",
    userId: process.env.IG_USER_ID?.trim() ?? "",
  },

  mediaMode: opt("MEDIA_MODE", "canva") as MediaMode,
  publicBaseUrl: opt("PUBLIC_BASE_URL", "http://127.0.0.1:3000").replace(/\/+$/, ""),
  tokenStore: opt("TOKEN_STORE", "browser") as TokenStoreMode,

  jpgQuality: int("JPG_QUALITY", 90),

  /** Escape hatch for the test suite, which proxies over loopback on purpose. */
  allowLocalPublicUrl: opt("ALLOW_LOCAL_PUBLIC_URL", "") === "1",
};

/** Hosts Instagram's crawler can never reach. */
export function isLocalUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return true; // unparseable is certainly not reachable
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "0.0.0.0" || host === "::" || host === "::1") return true;
  // RFC1918 + loopback + link-local
  return /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
}

export function assertPublishable(): void {
  if (!config.instagram.accessToken) {
    throw new Error("IG_ACCESS_TOKEN is not set — cannot publish to Instagram.");
  }
  if (config.mediaMode === "proxy" && isLocalUrl(config.publicBaseUrl) && !config.allowLocalPublicUrl) {
    throw new Error(
      `MEDIA_MODE=proxy requires a publicly reachable PUBLIC_BASE_URL — Instagram's servers must be able to fetch the image, and "${config.publicBaseUrl}" is local. ` +
        "Use a tunnel (ngrok/cloudflared), deploy the server, or set MEDIA_MODE=canva.",
    );
  }
}
