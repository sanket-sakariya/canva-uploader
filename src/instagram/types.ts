export interface IgContainer {
  id: string;
}

export type IgContainerStatus = "EXPIRED" | "ERROR" | "FINISHED" | "IN_PROGRESS" | "PUBLISHED";

export interface IgContainerStatusResponse {
  id: string;
  status_code: IgContainerStatus;
  status?: string;
}

export interface IgPublishResult {
  id: string;
  permalink?: string;
}

export interface IgAccount {
  id: string;
  username?: string;
  /** Present only when discovered through a Facebook Page. */
  pageName?: string;
}
