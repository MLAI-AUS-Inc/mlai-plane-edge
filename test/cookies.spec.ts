import { describe, expect, it } from "vitest";
import {
  buildDeniedCookieNames,
  filterCookieHeader,
  getSetCookieValues,
  sanitizeSetCookie,
  splitCombinedSetCookieHeader,
} from "../src/cookies";

describe("request Cookie isolation", () => {
  it("removes every exact MLAI cookie and allows known Plane cookies", () => {
    const denied = buildDeniedCookieNames();
    const cookie = [
      "access_token=mlai-access",
      "session-id=plane-session",
      "refresh_token=mlai-refresh",
      "admin-session-id=plane-admin",
      "sessionid=django",
      "csrftoken=plane-csrf",
      "__Host-plane-session=host-session",
    ].join("; ");

    expect(filterCookieHeader(cookie, denied)).toBe(
      "session-id=plane-session; admin-session-id=plane-admin; csrftoken=plane-csrf; __Host-plane-session=host-session",
    );
  });

  it("removes duplicate denied cookie names, including whitespace around equals", () => {
    const denied = buildDeniedCookieNames();

    expect(
      filterCookieHeader(
        "access_token=first; access_token = second; plane=value; sessionid=one; sessionid=two",
        denied,
      ),
    ).toBe("plane=value");
  });

  it("uses exact, case-sensitive names without removing lookalikes", () => {
    const denied = buildDeniedCookieNames();

    expect(
      filterCookieHeader(
        "ACCESS_TOKEN=case-sensitive; access_token_extra=near; mysessionid=near; session-id=plane",
        denied,
      ),
    ).toBe(
      "ACCESS_TOKEN=case-sensitive; access_token_extra=near; mysessionid=near; session-id=plane",
    );
  });

  it("handles malformed fragments without mistaking quoted semicolons for cookies", () => {
    const denied = buildDeniedCookieNames();

    expect(
      filterCookieHeader(
        'orphan-fragment; odd="value;still-value"; ; access_token=secret; okay=1',
        denied,
      ),
    ).toBe('orphan-fragment; odd="value;still-value"; okay=1');
  });

  it("deletes the Cookie header when only denied cookies remain", () => {
    const denied = buildDeniedCookieNames();
    expect(filterCookieHeader("access_token=a; refresh_token=b; sessionid=c", denied)).toBeUndefined();
  });

  it("supports a future configured denylist and ignores invalid configured names", () => {
    const denied = buildDeniedCookieNames(
      "CF_Authorization, future_session\nlegacy.auth invalid=name future_session",
    );

    expect(
      filterCookieHeader(
        "CF_Authorization=edge; future_session=one; legacy.auth=two; invalid=name=value; plane=ok",
        denied,
      ),
    ).toBe("invalid=name=value; plane=ok");
  });
});

describe("response Set-Cookie isolation", () => {
  it.each([
    "Domain=.mlai.au",
    "domain=mlai.au",
    "DOMAIN=\".MLAI.AU\"",
    "Domain=.mlai.au.",
  ])("removes an unsafe %s attribute and keeps other attributes", (domainAttribute) => {
    const original = `session-id=plane; Path=/; ${domainAttribute}; HttpOnly; SameSite=Lax`;

    expect(sanitizeSetCookie(original)).toBe(
      "session-id=plane; Path=/; HttpOnly; SameSite=Lax",
    );
  });

  it("removes every duplicate unsafe Domain attribute", () => {
    expect(
      sanitizeSetCookie(
        "session-id=plane; Domain=mlai.au; Path=/; domain=.MLAI.AU; Secure",
      ),
    ).toBe("session-id=plane; Path=/; Secure");
  });

  it("does not rewrite a distinct host-only or subdomain Domain", () => {
    expect(sanitizeSetCookie("session-id=plane; Domain=admin.mlai.au; Path=/")).toBe(
      "session-id=plane; Domain=admin.mlai.au; Path=/",
    );
    expect(sanitizeSetCookie("session-id=plane; Path=/; Secure")).toBe(
      "session-id=plane; Path=/; Secure",
    );
  });

  it("splits folded Set-Cookie without splitting an Expires date or quoted comma", () => {
    const folded = [
      "first=1; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/",
      'second="two,still-two"; Secure',
      "third=3; HttpOnly",
    ].join(", ");

    expect(splitCombinedSetCookieHeader(folded)).toEqual([
      "first=1; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/",
      'second="two,still-two"; Secure',
      "third=3; HttpOnly",
    ]);
  });

  it("preserves distinct Set-Cookie fields through the Workers Headers API", () => {
    const headers = new Headers();
    headers.append("Set-Cookie", "first=1; Path=/");
    headers.append("Set-Cookie", "second=2; HttpOnly");

    expect(getSetCookieValues(headers)).toEqual([
      "first=1; Path=/",
      "second=2; HttpOnly",
    ]);
  });
});
