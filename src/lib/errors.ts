/** An error that already knows which HTTP status the caller should see. */
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const notConnected = (): HttpError =>
  new HttpError(
    "Not connected to Canva yet. Open /auth/canva to authorize the integration.",
    401,
    "canva_not_connected",
  );
