import { describe, expect, it } from "vitest";
import { handleRequest, rebuildOriginResponse } from "../src/gateway";
import type { Env, Runtime } from "../src/types";

const PLANE_ENV: Env = {
  ROUTING_MODE: "plane",
  PLANE_ORIGIN_URL: "https://plane-origin.mlai.internal",
  PLANE_SOURCE_URL: "https://github.com/MLAI-AUS-Inc/mlai-plane/tree/917b23a6c16d93fc00cef67900eff2755e8b13f7",
  ADDITIONAL_DENIED_COOKIES: "CF_Authorization",
};

function responseCookies(response: Response): string[] {
  const headers = response.headers as Headers & {
    getAll(name: "Set-Cookie"): string[];
  };
  return headers.getAll("Set-Cookie");
}

function assertSecurityHeaders(response: Response): void {
  expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow, noarchive");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(response.headers.get("X-Frame-Options")).toBe("DENY");
  expect(response.headers.get("Referrer-Policy")).toBe("same-origin");
  expect(response.headers.get("Strict-Transport-Security")).toBe("max-age=31536000");
}

describe("Plane origin mode", () => {
  it("rewrites only the origin, filters cookies and replaces spoofable forwarding credentials", async () => {
    let forwarded: Request | undefined;
    const runtime: Runtime = {
      async fetch(request) {
        forwarded = request;
        return new Response("plane");
      },
    };
    const request = new Request("https://admin.mlai.au/workspaces/core?view=active", {
      headers: {
        Cookie: [
          "access_token=mlai",
          "session-id=plane",
          "sessionid=django",
          "admin-session-id=plane-admin",
          "CF_Authorization=outer-edge",
        ].join("; "),
        "CF-Access-Client-Id": "attacker-id",
        "CF-Access-Client-Secret": "attacker-secret",
        "CF-Connecting-IP": "203.0.113.42",
        Forwarded: "for=attacker;host=attacker.example;proto=http",
        "X-Forwarded-For": "198.51.100.99",
        "X-Forwarded-Host": "attacker.example",
        "X-Forwarded-Proto": "http",
        "X-Real-IP": "198.51.100.99",
      },
    });

    const response = await handleRequest(request, {
      ...PLANE_ENV,
      PLANE_ACCESS_CLIENT_ID: "trusted-id",
      PLANE_ACCESS_CLIENT_SECRET: "trusted-secret",
    }, runtime);

    expect(response.status).toBe(200);
    expect(forwarded).toBeDefined();
    expect(forwarded?.url).toBe(
      "https://plane-origin.mlai.internal/workspaces/core?view=active",
    );
    expect(forwarded?.headers.get("Cookie")).toBe(
      "session-id=plane; admin-session-id=plane-admin",
    );
    expect(forwarded?.headers.get("X-Forwarded-Host")).toBe("admin.mlai.au");
    expect(forwarded?.headers.get("X-Forwarded-Proto")).toBe("https");
    expect(forwarded?.headers.get("X-Forwarded-For")).toBe("203.0.113.42");
    expect(forwarded?.headers.get("X-Real-IP")).toBe("203.0.113.42");
    expect(forwarded?.headers.get("Forwarded")).toBeNull();
    expect(forwarded?.headers.get("CF-Access-Client-Id")).toBe("trusted-id");
    expect(forwarded?.headers.get("CF-Access-Client-Secret")).toBe("trusted-secret");
    expect(response.headers.get("Link")).toContain('rel="source"');
  });

  it("streams an upload body to the origin without pre-reading it", async () => {
    let receivedBody = "";
    const runtime: Runtime = {
      async fetch(request) {
        expect(request.bodyUsed).toBe(false);
        receivedBody = new TextDecoder().decode(await request.arrayBuffer());
        return new Response(null, { status: 204 });
      },
    };
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("large-upload-chunk"));
        controller.close();
      },
    });
    const request = new Request("https://admin.mlai.au/api/files", {
      method: "POST",
      body,
      headers: { "Content-Type": "application/octet-stream" },
    });

    const response = await handleRequest(request, PLANE_ENV, runtime);

    expect(response.status).toBe(204);
    expect(receivedBody).toBe("large-upload-chunk");
  });

  it("streams an origin response instead of buffering it", async () => {
    let pulled = false;
    const body = new ReadableStream({
      pull(controller) {
        pulled = true;
        controller.enqueue(new TextEncoder().encode("first-chunk"));
        controller.close();
      },
    });
    const runtime: Runtime = {
      async fetch() {
        return new Response(body);
      },
    };

    const response = await handleRequest(
      new Request("https://admin.mlai.au/stream"),
      PLANE_ENV,
      runtime,
    );

    expect(response.body).not.toBeNull();
    const chunk = await response.body?.getReader().read();
    expect(pulled).toBe(true);
    expect(new TextDecoder().decode(chunk?.value)).toBe("first-chunk");
  });

  it("preserves redirects and sanitizes every Plane Set-Cookie field", async () => {
    const headers = new Headers({ Location: "https://admin.mlai.au/sign-in" });
    headers.append(
      "Set-Cookie",
      "session-id=plane; Domain=.mlai.au; Path=/; Secure; HttpOnly",
    );
    headers.append("Set-Cookie", "csrftoken=csrf; Path=/; SameSite=Lax");
    headers.set("Server", "origin-secret-version");
    const runtime: Runtime = {
      async fetch() {
        return new Response(null, { status: 302, headers });
      },
    };

    const response = await handleRequest(
      new Request("https://admin.mlai.au/oauth/callback"),
      PLANE_ENV,
      runtime,
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("https://admin.mlai.au/sign-in");
    expect(responseCookies(response)).toEqual([
      "session-id=plane; Path=/; Secure; HttpOnly",
      "csrftoken=csrf; Path=/; SameSite=Lax",
    ]);
    expect(response.headers.get("Server")).toBeNull();
    assertSecurityHeaders(response);
  });

  it("preserves the proxied WebSocket on a 101 response", async () => {
    const pair = new WebSocketPair();
    const upstream = new Response(null, {
      status: 101,
      webSocket: pair[0],
    });
    const runtime: Runtime = {
      async fetch(request) {
        expect(request.headers.get("Upgrade")).toBe("websocket");
        return upstream;
      },
    };

    const response = await handleRequest(
      new Request("https://admin.mlai.au/live", {
        headers: { Upgrade: "websocket" },
      }),
      PLANE_ENV,
      runtime,
    );

    expect(response.status).toBe(101);
    expect(response.webSocket).toBe(pair[0]);
  });

  it.each([
    {
      env: { ...PLANE_ENV, PLANE_ORIGIN_URL: "http://plane.internal" },
      label: "an insecure origin",
    },
    {
      env: { ...PLANE_ENV, PLANE_ORIGIN_URL: "https://admin.mlai.au" },
      label: "a recursive origin",
    },
    {
      env: { ...PLANE_ENV, PLANE_ORIGIN_URL: "https://replace-me.invalid" },
      label: "a placeholder origin",
    },
    {
      env: { ...PLANE_ENV, PLANE_ACCESS_CLIENT_ID: "only-half" },
      label: "a partial service token",
    },
    {
      env: { ...PLANE_ENV, PLANE_SOURCE_URL: "https://github.com/MLAI-AUS-Inc/mlai-plane" },
      label: "a non-immutable source URL",
    },
  ])("fails closed for $label", async ({ env }) => {
    let called = false;
    const response = await handleRequest(
      new Request("https://admin.mlai.au/"),
      env,
      { async fetch() { called = true; return new Response("unexpected"); } },
    );

    expect(called).toBe(false);
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("Service temporarily unavailable");
    assertSecurityHeaders(response);
  });

  it("does not expose origin errors or credentials", async () => {
    const response = await handleRequest(
      new Request("https://admin.mlai.au/"),
      {
        ...PLANE_ENV,
        PLANE_ACCESS_CLIENT_ID: "sensitive-id",
        PLANE_ACCESS_CLIENT_SECRET: "sensitive-secret",
      },
      { async fetch() { throw new Error("sensitive-secret at private-origin.internal"); } },
    );

    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).toBe("Service temporarily unavailable");
    expect(text).not.toContain("sensitive");
    expect(text).not.toContain("private-origin");
  });

  it("serves an immutable AGPL source disclosure without calling the origin", async () => {
    let called = false;
    const response = await handleRequest(
      new Request("https://admin.mlai.au/.well-known/mlai-source"),
      PLANE_ENV,
      { async fetch() { called = true; return new Response("unexpected"); } },
    );

    expect(called).toBe(false);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      license: "AGPL-3.0-only",
      source: PLANE_ENV.PLANE_SOURCE_URL,
      upstream_release: "v1.4.0",
    });
    expect(response.headers.get("Link")).toBe(
      `<${PLANE_ENV.PLANE_SOURCE_URL}>; rel="source"`,
    );
  });
});

describe("legacy rollback mode", () => {
  it("uses the service binding and preserves trusted legacy cookies in both directions", async () => {
    let forwarded: Request | undefined;
    const legacyBinding = {
      async fetch(request: Request) {
        forwarded = request;
        return new Response("legacy", {
          headers: {
            "Set-Cookie": "legacy=1; Domain=.mlai.au; Path=/; HttpOnly",
          },
        });
      },
    } as unknown as Fetcher;
    const request = new Request("https://admin.mlai.au/review", {
      headers: {
        Cookie: "access_token=needed-by-legacy; sessionid=django",
        "CF-Access-Client-Secret": "must-not-pass-through",
      },
    });

    const response = await handleRequest(request, {
      ROUTING_MODE: "legacy",
      LEGACY_ADMIN: legacyBinding,
    });

    expect(await response.text()).toBe("legacy");
    expect(forwarded?.url).toBe("https://admin.mlai.au/review");
    expect(forwarded?.headers.get("Cookie")).toBe(
      "access_token=needed-by-legacy; sessionid=django",
    );
    expect(forwarded?.headers.get("CF-Access-Client-Secret")).toBeNull();
    expect(responseCookies(response)).toEqual([
      "legacy=1; Domain=.mlai.au; Path=/; HttpOnly",
    ]);
    assertSecurityHeaders(response);
  });

  it("preserves distinct parent-domain cookie deletions required by legacy logout", async () => {
    const logoutCookies = [
      "access_token=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Domain=.mlai.au; Path=/; HttpOnly; Secure",
      "refresh_token=; Max-Age=0; Domain=mlai.au; Path=/; HttpOnly; Secure",
      "sessionid=; Max-Age=0; Domain=.mlai.au; Path=/; HttpOnly; Secure; SameSite=Lax",
    ];
    const legacyBinding = {
      async fetch() {
        const headers = new Headers({ Location: "https://mlai.au/" });
        for (const cookie of logoutCookies) {
          headers.append("Set-Cookie", cookie);
        }
        return new Response(null, { status: 302, headers });
      },
    } as unknown as Fetcher;

    const response = await handleRequest(
      new Request("https://admin.mlai.au/logout", {
        headers: { Cookie: "access_token=old; refresh_token=old; sessionid=old" },
      }),
      { ROUTING_MODE: "legacy", LEGACY_ADMIN: legacyBinding },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("https://mlai.au/");
    expect(responseCookies(response)).toEqual(logoutCookies);
    assertSecurityHeaders(response);
  });

  it("fails closed when the legacy binding is unavailable", async () => {
    const response = await handleRequest(
      new Request("https://admin.mlai.au/"),
      { ROUTING_MODE: "legacy" },
    );

    expect(response.status).toBe(503);
    assertSecurityHeaders(response);
  });
});

describe("configuration and response invariants", () => {
  it("fails closed for an unknown routing mode", async () => {
    const response = await handleRequest(
      new Request("https://admin.mlai.au/"),
      { ROUTING_MODE: "typo" },
    );

    expect(response.status).toBe(503);
    assertSecurityHeaders(response);
  });

  it("keeps status, status text and a null body for bodyless responses", () => {
    const response = rebuildOriginResponse(
      new Response(null, {
        status: 204,
        statusText: "No Content",
      }),
      "plane",
    );

    expect(response.status).toBe(204);
    expect(response.statusText).toBe("No Content");
    expect(response.body).toBeNull();
  });
});
