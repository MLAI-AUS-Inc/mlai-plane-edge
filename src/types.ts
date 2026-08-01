export type RoutingMode = "legacy" | "plane";

export interface Env {
  ROUTING_MODE?: string;
  PLANE_ORIGIN_URL?: string;
  PLANE_SOURCE_URL?: string;
  ADDITIONAL_DENIED_COOKIES?: string;
  PLANE_ACCESS_CLIENT_ID?: string;
  PLANE_ACCESS_CLIENT_SECRET?: string;
  LEGACY_ADMIN?: Fetcher;
}

export interface Runtime {
  fetch(request: Request): Promise<Response>;
}
