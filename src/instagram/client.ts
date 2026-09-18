import { config } from "../config.js";
import { requestJson, sleep } from "../lib/http.js";
import { log } from "../lib/logger.js";
import type {
  IgAccount,
  IgContainer,
  IgContainerStatusResponse,
  IgPublishResult,
} from "./types.js";

export const IG_CAPTION_MAX = 2_200;
export const IG_CAROUSEL_MAX = 10;
export const IG_CAROUSEL_MIN = 2;

export class InstagramClient {
  private readonly base: string;

  constructor(
    private readonly accessToken: string,
    private igUserId: string,
  ) {
    if (!accessToken) throw new Error("InstagramClient requires an access token");
    this.base = config.instagram.base;
  }

  get userId(): string {
    return this.igUserId;
  }

  private post<T>(path: string, params: Record<string, string>): Promise<T> {
    const body = new URLSearchParams({ ...params, access_token: this.accessToken });
    return requestJson<T>(`${this.base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      retries: 2,
    });
  }

  private get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const qs = new URLSearchParams({ ...params, access_token: this.accessToken });
    return requestJson<T>(`${this.base}${path}?${qs}`, { retries: 2 });
  }

  /**
   * Figures out which Instagram Business account the token can post as.
   * Works for both token flavours: Instagram Login talks to graph.instagram.com
   * and answers /me directly; Facebook Login has to walk the user's Pages.
   */
  static async discoverAccount(accessToken: string): Promise<IgAccount> {
    const base = config.instagram.base;

    if (config.instagram.host === "graph.instagram.com") {
      const me = await requestJson<{ user_id?: string; id?: string; username?: string }>(
        `${base}/me?fields=user_id,username&access_token=${encodeURIComponent(accessToken)}`,
      );
      const id = me.user_id ?? me.id;
      if (!id) throw new Error("Could not resolve an Instagram user id from the token.");
      return { id, username: me.username };
    }

    const pages = await requestJson<{
      data: Array<{ id: string; name: string; instagram_business_account?: { id: string; username?: string } }>;
    }>(
      `${base}/me/accounts?fields=name,instagram_business_account{id,username}&access_token=${encodeURIComponent(accessToken)}`,
    );

    const linked = pages.data?.find((p) => p.instagram_business_account?.id);
    if (!linked?.instagram_business_account) {
      throw new Error(
        "No Instagram Business account is linked to any Facebook Page this token can see. " +
          "Convert the IG account to Business/Creator, link it to a Page, and make sure the token carries instagram_basic + instagram_content_publish + pages_read_engagement.",
      );
    }
    return {
      id: linked.instagram_business_account.id,
      username: linked.instagram_business_account.username,
      pageName: linked.name,
    };
  }

  /** Step 1 — stage an image. Instagram fetches `imageUrl` from its own servers. */
  async createImageContainer(imageUrl: string, opts: { caption?: string; isCarouselItem?: boolean } = {}): Promise<string> {
    const params: Record<string, string> = { image_url: imageUrl };
    if (opts.isCarouselItem) params.is_carousel_item = "true";
    else if (opts.caption) params.caption = opts.caption;

    const res = await this.post<IgContainer>(`/${this.igUserId}/media`, params);
    log.info(`IG container ${res.id} created`);
    return res.id;
  }

  /** Step 1b — group 2-10 staged items into a carousel. */
  async createCarouselContainer(childIds: string[], caption?: string): Promise<string> {
    if (childIds.length < IG_CAROUSEL_MIN || childIds.length > IG_CAROUSEL_MAX) {
      throw new Error(`An Instagram carousel needs ${IG_CAROUSEL_MIN}-${IG_CAROUSEL_MAX} items, got ${childIds.length}.`);
    }
    const params: Record<string, string> = {
      media_type: "CAROUSEL",
      children: childIds.join(","),
    };
    if (caption) params.caption = caption;

    const res = await this.post<IgContainer>(`/${this.igUserId}/media`, params);
    log.info(`IG carousel container ${res.id} created with ${childIds.length} children`);
    return res.id;
  }

  async getContainerStatus(containerId: string): Promise<IgContainerStatusResponse> {
    return this.get<IgContainerStatusResponse>(`/${containerId}`, { fields: "status_code,status" });
  }

  /**
   * Step 2 — wait until Instagram has downloaded and processed the media.
   * Images are usually FINISHED on the first poll; this mainly guards against
   * Instagram failing to reach the image URL.
   */
  async waitForContainer(containerId: string, timeoutMs = 300_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let delay = 2_000;

    while (true) {
      const { status_code, status } = await this.getContainerStatus(containerId);
      log.debug(`container ${containerId} status=${status_code}`);

      if (status_code === "FINISHED" || status_code === "PUBLISHED") return;
      if (status_code === "ERROR") {
        throw new Error(
          `Instagram could not process container ${containerId}${status ? `: ${status}` : ""}. ` +
            "This is almost always a media problem — the URL wasn't publicly reachable, wasn't a real JPEG, or the aspect ratio was out of range.",
        );
      }
      if (status_code === "EXPIRED") {
        throw new Error(`Container ${containerId} expired before it was published (containers live 24h).`);
      }
      if (Date.now() > deadline) {
        throw new Error(`Container ${containerId} was still ${status_code} after ${Math.round(timeoutMs / 1000)}s.`);
      }
      await sleep(delay);
      delay = Math.min(delay * 1.5, 15_000);
    }
  }

  /** Step 3 — actually put it on the profile. */
  async publish(creationId: string): Promise<IgPublishResult> {
    const res = await this.post<IgPublishResult>(`/${this.igUserId}/media_publish`, {
      creation_id: creationId,
    });
    log.info(`IG media ${res.id} published`);
    return res;
  }

  async getPermalink(mediaId: string): Promise<string | undefined> {
    try {
      const res = await this.get<{ permalink?: string }>(`/${mediaId}`, { fields: "permalink" });
      return res.permalink;
    } catch {
      return undefined; // nice-to-have; never fail a successful publish over it
    }
  }

  /** How many of the 100/24h publishes are left. */
  async getPublishingLimit(): Promise<{ quotaUsage: number; quotaTotal: number } | null> {
    try {
      const res = await this.get<{ data?: Array<{ quota_usage?: number; config?: { quota_total?: number } }> }>(
        `/${this.igUserId}/content_publishing_limit`,
        { fields: "config,quota_usage" },
      );
      const row = res.data?.[0];
      if (!row) return null;
      return { quotaUsage: row.quota_usage ?? 0, quotaTotal: row.config?.quota_total ?? 100 };
    } catch {
      return null;
    }
  }
}

export function validateCaption(caption: string | undefined): void {
  if (caption && caption.length > IG_CAPTION_MAX) {
    throw new Error(`Caption is ${caption.length} characters; Instagram allows ${IG_CAPTION_MAX}.`);
  }
}
