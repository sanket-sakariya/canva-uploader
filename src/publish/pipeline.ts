import { assertPublishable, config } from "../config.js";
import { CanvaClient } from "../canva/client.js";
import {
  InstagramClient,
  IG_CAROUSEL_MAX,
  validateCaption,
} from "../instagram/client.js";
import { checkInstagramAspect, readJpegDimensions, type Dimensions } from "../lib/jpeg.js";
import { requestBuffer } from "../lib/http.js";
import { log } from "../lib/logger.js";
import * as mediaStore from "../store/mediaStore.js";

export type PublishMode = "auto" | "single" | "carousel";

export interface PublishRequest {
  canvaAccessToken: string;
  designId: string;
  caption?: string;
  /** 1-based Canva page numbers. Omit to export every page. */
  pages?: number[];
  mode?: PublishMode;
  /** Export the image but stop before touching Instagram. */
  dryRun?: boolean;
  /** Publish even if the design isn't inside Instagram's 4:5-1.91:1 window. */
  ignoreAspectRatio?: boolean;
  onProgress?: (step: ProgressEvent) => void;
}

export interface ProgressEvent {
  step: string;
  detail?: string;
}

export interface PublishedImage {
  page: number;
  sourceUrl: string;
  deliveredUrl: string;
  dimensions?: Dimensions;
  aspectRatio?: number;
  containerId?: string;
}

export interface PublishReport {
  designId: string;
  designTitle?: string;
  mode: "single" | "carousel";
  dryRun: boolean;
  images: PublishedImage[];
  mediaId?: string;
  permalink?: string;
  caption?: string;
  warnings: string[];
  quota?: { quotaUsage: number; quotaTotal: number };
  elapsedMs: number;
}

/**
 * The whole point of this project:
 *   Canva design  ->  JPG export  ->  Instagram feed post
 * No Canva editor, no manual download, no re-upload.
 */
export async function publishDesignToInstagram(req: PublishRequest): Promise<PublishReport> {
  const started = Date.now();
  const warnings: string[] = [];
  const emit = (step: string, detail?: string) => {
    log.info(detail ? `${step} — ${detail}` : step);
    req.onProgress?.({ step, detail });
  };

  validateCaption(req.caption);
  if (!req.dryRun) assertPublishable();

  const canva = new CanvaClient(req.canvaAccessToken);

  // 1. Design metadata (nice titles in the report, and a page-count sanity check).
  emit("Reading design", req.designId);
  const design = await canva.getDesign(req.designId).catch((err) => {
    log.warn(`Could not read design metadata: ${(err as Error).message}`);
    return null;
  });

  // 2. Render it. Canva returns one URL per page.
  emit("Exporting design as JPG", `quality ${config.jpgQuality}`);
  const exportUrls = await canva.exportDesignAsJpg(req.designId, {
    quality: config.jpgQuality,
    pages: req.pages,
  });

  const mode: "single" | "carousel" = resolveMode(req.mode ?? "auto", exportUrls.length);
  let urls = exportUrls;

  if (mode === "single" && urls.length > 1) {
    warnings.push(`Design has ${urls.length} pages; publishing page 1 only (pass mode="carousel" to post all of them).`);
    urls = urls.slice(0, 1);
  }
  if (mode === "carousel" && urls.length > IG_CAROUSEL_MAX) {
    warnings.push(`Design has ${urls.length} pages; Instagram carousels cap at ${IG_CAROUSEL_MAX}, so the rest were dropped.`);
    urls = urls.slice(0, IG_CAROUSEL_MAX);
  }

  // 3. Get the bytes in front of Instagram, and pre-flight them so we fail with
  //    a readable message instead of Instagram's generic container ERROR.
  const images: PublishedImage[] = [];
  for (const [index, sourceUrl] of urls.entries()) {
    const page = req.pages?.[index] ?? index + 1;
    emit("Preparing image", `page ${page}`);

    const buffer = await requestBuffer(sourceUrl);
    const dimensions = readJpegDimensions(buffer) ?? undefined;

    if (dimensions) {
      const aspect = checkInstagramAspect(dimensions);
      if (!aspect.ok) {
        if (req.ignoreAspectRatio) warnings.push(`Page ${page}: ${aspect.hint} Instagram will crop it.`);
        else throw new Error(`Page ${page}: ${aspect.hint} Pass ignoreAspectRatio to publish anyway.`);
      }
      images.push({
        page,
        sourceUrl,
        deliveredUrl: deliver(sourceUrl, buffer),
        dimensions,
        aspectRatio: Number((dimensions.width / dimensions.height).toFixed(3)),
      });
    } else {
      warnings.push(`Page ${page}: could not read JPEG dimensions; skipping the aspect-ratio pre-flight.`);
      images.push({ page, sourceUrl, deliveredUrl: deliver(sourceUrl, buffer) });
    }
  }

  if (req.dryRun) {
    emit("Dry run complete", "nothing was posted to Instagram");
    return {
      designId: req.designId,
      designTitle: design?.title,
      mode,
      dryRun: true,
      images,
      caption: req.caption,
      warnings,
      elapsedMs: Date.now() - started,
    };
  }

  // 4. Stage, wait, publish.
  const ig = await instagramClient();
  const quota = (await ig.getPublishingLimit()) ?? undefined;
  if (quota && quota.quotaUsage >= quota.quotaTotal) {
    throw new Error(`Instagram publishing quota exhausted (${quota.quotaUsage}/${quota.quotaTotal} in the last 24h).`);
  }

  let creationId: string;
  if (mode === "carousel") {
    for (const image of images) {
      emit("Staging carousel item", `page ${image.page}`);
      image.containerId = await ig.createImageContainer(image.deliveredUrl, { isCarouselItem: true });
    }
    for (const image of images) {
      emit("Waiting for Instagram to fetch image", `page ${image.page}`);
      await ig.waitForContainer(image.containerId!);
    }
    emit("Creating carousel container", `${images.length} items`);
    creationId = await ig.createCarouselContainer(images.map((i) => i.containerId!), req.caption);
    await ig.waitForContainer(creationId);
  } else {
    const [image] = images as [PublishedImage];
    emit("Staging image container");
    image.containerId = await ig.createImageContainer(image.deliveredUrl, { caption: req.caption });
    creationId = image.containerId;
    emit("Waiting for Instagram to fetch image");
    await ig.waitForContainer(creationId);
  }

  emit("Publishing to Instagram");
  const published = await ig.publish(creationId);
  const permalink = published.permalink ?? (await ig.getPermalink(published.id));

  emit("Published", permalink ?? published.id);

  return {
    designId: req.designId,
    designTitle: design?.title,
    mode,
    dryRun: false,
    images,
    mediaId: published.id,
    permalink,
    caption: req.caption,
    warnings,
    quota,
    elapsedMs: Date.now() - started,
  };
}

function resolveMode(requested: PublishMode, pageCount: number): "single" | "carousel" {
  if (requested === "single") return "single";
  if (requested === "carousel") return "carousel";
  return pageCount > 1 ? "carousel" : "single"; // auto
}

/** Either hand Instagram the Canva URL, or re-host the bytes ourselves. */
function deliver(sourceUrl: string, buffer: Buffer): string {
  if (config.mediaMode === "proxy") return mediaStore.put(buffer).url;
  return sourceUrl;
}

let cachedIg: InstagramClient | null = null;

export async function instagramClient(): Promise<InstagramClient> {
  if (cachedIg) return cachedIg;
  const token = config.instagram.accessToken;
  const userId = config.instagram.userId || (await InstagramClient.discoverAccount(token)).id;
  cachedIg = new InstagramClient(token, userId);
  return cachedIg;
}
