import {
  buildDeniedCookieNames,
  filterCookieHeader,
  getSetCookieValues,
  sanitizeSetCookie,
} from "./cookies";
import type { Env, RoutingMode, Runtime } from "./types";

const NO_BODY_STATUSES = new Set([101, 204, 205, 304]);
const ACCESS_CLIENT_ID_HEADER = "CF-Access-Client-Id";
const ACCESS_CLIENT_SECRET_HEADER = "CF-Access-Client-Secret";
const SOURCE_PATH = "/.well-known/mlai-source";
const SOURCE_URL_PATTERN = /^https:\/\/github\.com\/MLAI-AUS-Inc\/mlai-plane\/tree\/[0-9a-f]{40}$/u;

const SECURITY_HEADERS = Object.freeze({
  "Referrer-Policy": "same-origin",
  "Strict-Transport-Security": "max-age=31536000",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
} as const);

function withSecurityHeaders(headers: Headers, sourceUrl?: string): Headers {
  headers.delete("Server");
  headers.delete("X-Powered-By");

  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }

  if (sourceUrl) {
    headers.append("Link", `<${sourceUrl}>; rel="source"`);
  }

  return headers;
}

function unavailable(status = 503): Response {
  const headers = withSecurityHeaders(new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "text/plain; charset=utf-8",
  }));
  return new Response("Service temporarily unavailable", { status, headers });
}

function parseRoutingMode(value?: string): RoutingMode | undefined {
  const mode = value?.trim();
  return mode === "legacy" || mode === "plane" ? mode : undefined;
}

function responseHeaders(
  originHeaders: Headers,
  mode: RoutingMode,
  sourceUrl?: string,
): Headers {
  if (mode === "legacy") {
    return withSecurityHeaders(new Headers(originHeaders));
  }

  const setCookieValues = getSetCookieValues(originHeaders);
  const headers = new Headers(originHeaders);
  headers.delete("Set-Cookie");

  for (const value of setCookieValues) {
    const sanitized = sanitizeSetCookie(value);
    if (sanitized) {
      headers.append("Set-Cookie", sanitized);
    }
  }

  return withSecurityHeaders(headers, sourceUrl);
}

type WorkerResponse = Response & { webSocket?: WebSocket | null };
type WorkerResponseInit = ResponseInit & { webSocket?: WebSocket | null };

export function rebuildOriginResponse(
  originResponse: Response,
  mode: RoutingMode,
  sourceUrl?: string,
): Response {
  const workerResponse = originResponse as WorkerResponse;
  const init: WorkerResponseInit = {
    headers: responseHeaders(originResponse.headers, mode, sourceUrl),
    status: originResponse.status,
    statusText: originResponse.statusText,
  };

  if (workerResponse.webSocket) {
    init.webSocket = workerResponse.webSocket;
  }

  const body = NO_BODY_STATUSES.has(originResponse.status) ? null : originResponse.body;
  return new Response(body, init);
}

function resolvePlaneSourceUrl(configuredSource?: string): string | undefined {
  if (!configuredSource) {
    return undefined;
  }

  const source = configuredSource.trim();
  return SOURCE_URL_PATTERN.test(source) ? source : undefined;
}

function sourceDisclosure(sourceUrl: string): Response {
  const headers = withSecurityHeaders(new Headers({
    "Cache-Control": "public, max-age=300",
    "Content-Type": "application/json; charset=utf-8",
  }), sourceUrl);
  return Response.json({
    license: "AGPL-3.0-only",
    source: sourceUrl,
    upstream_release: "v1.4.0",
  }, { headers });
}

function baseForwardHeaders(request: Request): Headers {
  const requestUrl = new URL(request.url);
  const headers = new Headers(request.headers);

  headers.delete("Host");
  headers.delete("Forwarded");
  headers.delete("X-Forwarded-For");
  headers.delete("X-Forwarded-Host");
  headers.delete("X-Forwarded-Port");
  headers.delete("X-Forwarded-Proto");
  headers.delete("X-Real-IP");
  headers.delete(ACCESS_CLIENT_ID_HEADER);
  headers.delete(ACCESS_CLIENT_SECRET_HEADER);

  const clientIp = request.headers.get("CF-Connecting-IP");
  if (clientIp) {
    headers.set("X-Forwarded-For", clientIp);
    headers.set("X-Real-IP", clientIp);
  }

  headers.set("X-Forwarded-Host", requestUrl.host);
  headers.set("X-Forwarded-Proto", requestUrl.protocol.slice(0, -1));

  return headers;
}

function requestInit(request: Request, headers: Headers): RequestInit {
  const init: RequestInit = {
    headers,
    method: request.method,
    redirect: "manual",
    signal: request.signal,
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
  }

  return init;
}

function createLegacyRequest(request: Request): Request {
  const headers = baseForwardHeaders(request);
  return new Request(request.url, requestInit(request, headers));
}

function resolvePlaneTarget(request: Request, configuredOrigin?: string): URL | undefined {
  if (!configuredOrigin) {
    return undefined;
  }

  let origin: URL;
  try {
    origin = new URL(configuredOrigin.trim());
  } catch {
    return undefined;
  }

  const publicUrl = new URL(request.url);
  const hasUnsupportedParts =
    origin.protocol !== "https:" ||
    Boolean(origin.username) ||
    Boolean(origin.password) ||
    Boolean(origin.search) ||
    Boolean(origin.hash) ||
    (origin.pathname !== "" && origin.pathname !== "/") ||
    origin.hostname.endsWith(".invalid") ||
    origin.host === publicUrl.host;

  if (hasUnsupportedParts) {
    return undefined;
  }

  const target = new URL(origin.origin);
  target.pathname = publicUrl.pathname;
  target.search = publicUrl.search;
  return target;
}

function createPlaneRequest(request: Request, env: Env): Request | undefined {
  const target = resolvePlaneTarget(request, env.PLANE_ORIGIN_URL);
  if (!target) {
    return undefined;
  }

  const hasAccessClientId = Boolean(env.PLANE_ACCESS_CLIENT_ID);
  const hasAccessClientSecret = Boolean(env.PLANE_ACCESS_CLIENT_SECRET);
  if (hasAccessClientId !== hasAccessClientSecret) {
    return undefined;
  }

  const headers = baseForwardHeaders(request);
  const cookieHeader = headers.get("Cookie");
  if (cookieHeader !== null) {
    const filtered = filterCookieHeader(
      cookieHeader,
      buildDeniedCookieNames(env.ADDITIONAL_DENIED_COOKIES),
    );
    if (filtered) {
      headers.set("Cookie", filtered);
    } else {
      headers.delete("Cookie");
    }
  }

  if (env.PLANE_ACCESS_CLIENT_ID && env.PLANE_ACCESS_CLIENT_SECRET) {
    headers.set(ACCESS_CLIENT_ID_HEADER, env.PLANE_ACCESS_CLIENT_ID);
    headers.set(ACCESS_CLIENT_SECRET_HEADER, env.PLANE_ACCESS_CLIENT_SECRET);
  }

  return new Request(target, requestInit(request, headers));
}

export async function handleRequest(
  request: Request,
  env: Env,
  runtime: Runtime = { fetch: (outboundRequest) => fetch(outboundRequest) },
): Promise<Response> {
  const mode = parseRoutingMode(env.ROUTING_MODE);
  if (!mode) {
    return unavailable();
  }

  try {
    if (mode === "legacy") {
      if (!env.LEGACY_ADMIN) {
        return unavailable();
      }

      const legacyResponse = await env.LEGACY_ADMIN.fetch(createLegacyRequest(request));
      return rebuildOriginResponse(legacyResponse, "legacy");
    }

    const sourceUrl = resolvePlaneSourceUrl(env.PLANE_SOURCE_URL);
    if (!sourceUrl) {
      return unavailable();
    }

    if (new URL(request.url).pathname === SOURCE_PATH) {
      return sourceDisclosure(sourceUrl);
    }

    const planeRequest = createPlaneRequest(request, env);
    if (!planeRequest) {
      return unavailable();
    }

    const planeResponse = await runtime.fetch(planeRequest);
    return rebuildOriginResponse(planeResponse, "plane", sourceUrl);
  } catch {
    return unavailable(502);
  }
}
