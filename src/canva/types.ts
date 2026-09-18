export interface CanvaTokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope: string;
}

export interface CanvaDesign {
  id: string;
  title?: string;
  owner: { user_id: string; team_id: string };
  thumbnail?: { width: number; height: number; url: string };
  urls: { edit_url: string; view_url: string };
  created_at: number;
  updated_at: number;
  page_count?: number;
}

export interface ListDesignsResponse {
  items: CanvaDesign[];
  continuation?: string;
}

export type ExportStatus = "in_progress" | "success" | "failed";

export interface ExportJob {
  id: string;
  status: ExportStatus;
  urls?: string[];
  error?: { code: string; message: string };
}

export interface ExportJobResponse {
  job: ExportJob;
}

/** Only the JPG variant is modelled — Instagram accepts nothing else. */
export interface JpgExportFormat {
  type: "jpg";
  quality: number;
  export_quality?: "regular" | "pro";
  height?: number;
  width?: number;
  pages?: number[];
}
