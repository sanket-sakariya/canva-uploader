import { createHash, randomBytes } from "node:crypto";

const base64url = (buf: Buffer): string => buf.toString("base64url");

export interface Pkce {
  verifier: string;
  challenge: string;
}

/**
 * RFC 7636 S256 pair. Canva requires the verifier to stay server-side, so this
 * is only ever called from the backend and the verifier is held in the session.
 */
export function createPkce(): Pkce {
  const verifier = base64url(randomBytes(64)); // 86 chars, inside the 43-128 range
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export const randomState = (): string => base64url(randomBytes(24));
