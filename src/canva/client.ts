import { config } from "../config.js";
import { ApiError, requestJson, sleep } from "../lib/http.js";
import { log } from "../lib/logger.js";
import type {
  CanvaDesign,
  ExportJob,
  ExportJobResponse,
  JpgExportFormat,
  ListDesignsResponse,
} from "./types.js";

export class CanvaClient {
  constructor(private readonly accessToken: string) {
    if (!accessToken) throw new Error("CanvaClient requires an access token");
  }

  private headers(json = false): Record<string, string> {
    const h: Record<string, string> = { Authorization: `Bearer ${this.accessToken}` };
    if (json) h["Content-Type"] = "application/json";
    return h;
  }

  /** Scope: design:meta:read */
  async listDesigns(opts: { query?: string; limit?: number; continuation?: string } = {}): Promise<ListDesignsResponse> {
    const params = new URLSearchParams({
      limit: String(opts.limit ?? 30),
      sort_by: opts.query ? "relevance" : "modified_descending",
    });
    if (opts.query) params.set("query", opts.query);
    if (opts.continuation) params.set("continuation", opts.continuation);

    return requestJson<ListDesignsResponse>(`${config.canva.apiBase}/designs?${params}`, {
      headers: this.headers(),
    });
  }

  /** Scope: design:meta:read */
  async getDesign(designId: string): Promise<CanvaDesign> {
    const res = await requestJson<{ design: CanvaDesign }>(
      `${config.canva.apiBase}/designs/${encodeURIComponent(designId)}`,
      { headers: this.headers() },
    );
    return res.design;
  }

  /** Scope: design:content:read. Async job — poll with {@link getExportJob}. */
  async createExportJob(designId: string, format: JpgExportFormat): Promise<ExportJob> {
    const res = await requestJson<ExportJobResponse>(`${config.canva.apiBase}/exports`, {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({ design_id: designId, format }),
    });
    return res.job;
  }

  async getExportJob(exportId: string): Promise<ExportJob> {
    const res = await requestJson<ExportJobResponse>(
      `${config.canva.apiBase}/exports/${encodeURIComponent(exportId)}`,
      { headers: this.headers() },
    );
    return res.job;
  }

  /**
   * Creates a JPG export and blocks until Canva finishes rendering it.
   * Returns one download URL per exported page (URLs expire after 24 hours).
   */
  async exportDesignAsJpg(
    designId: string,
    opts: { quality?: number; pages?: number[]; width?: number; height?: number; timeoutMs?: number } = {},
  ): Promise<string[]> {
    const format: JpgExportFormat = { type: "jpg", quality: opts.quality ?? config.jpgQuality };
    if (opts.pages?.length) format.pages = opts.pages;
    if (opts.width) format.width = opts.width;
    if (opts.height) format.height = opts.height;

    const job = await this.createExportJob(designId, format);
    log.info(`Canva export job ${job.id} created for design ${designId}`);

    const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
    let current = job;
    let delay = 1_000;

    while (current.status === "in_progress") {
      if (Date.now() > deadline) {
        throw new Error(`Canva export job ${job.id} did not finish within the timeout.`);
      }
      await sleep(delay);
      delay = Math.min(delay * 1.4, 5_000); // ease off while long renders finish
      current = await this.getExportJob(job.id);
      log.debug(`export ${job.id} status=${current.status}`);
    }

    if (current.status === "failed") {
      throw new Error(explainExportFailure(current));
    }
    if (!current.urls?.length) {
      throw new Error(`Canva export job ${job.id} succeeded but returned no download URLs.`);
    }
    log.info(`Canva export job ${job.id} produced ${current.urls.length} file(s)`);
    return current.urls;
  }
}

function explainExportFailure(job: ExportJob): string {
  const code = job.error?.code ?? "unknown";
  const message = job.error?.message ?? "no message";
  const hints: Record<string, string> = {
    license_required:
      "The design uses premium elements that aren't licensed on this account. Open the design in Canva and purchase/replace the premium assets, then retry.",
    approval_required: "The design is pending brand approval in Canva. Get it approved, then retry.",
    internal_failure: "Canva hit an internal rendering error. Retrying usually clears it.",
  };
  const hint = hints[code];
  return `Canva export failed (${code}): ${message}${hint ? ` — ${hint}` : ""}`;
}

/** Turns a 401 from Canva into something callers can branch on. */
export function isCanvaAuthError(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 401 || err.status === 403);
}
