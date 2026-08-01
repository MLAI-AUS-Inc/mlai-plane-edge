const COOKIE_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export const MLAI_COOKIE_DENYLIST = Object.freeze([
  "access_token",
  "refresh_token",
  "sessionid",
] as const);

function splitOnSemicolons(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (quoted && character === "\\") {
      escaped = true;
      continue;
    }

    if (character === '"') {
      quoted = !quoted;
      continue;
    }

    if (!quoted && character === ";") {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }

  parts.push(value.slice(start));
  return parts;
}

export function buildDeniedCookieNames(additionalNames?: string): ReadonlySet<string> {
  const names = new Set<string>(MLAI_COOKIE_DENYLIST);

  if (!additionalNames) {
    return names;
  }

  for (const candidate of additionalNames.split(/[\s,]+/u)) {
    const name = candidate.trim();
    if (name && COOKIE_NAME_PATTERN.test(name)) {
      names.add(name);
    }
  }

  return names;
}

export function filterCookieHeader(
  cookieHeader: string,
  deniedNames: ReadonlySet<string>,
): string | undefined {
  const retained: string[] = [];

  for (const rawPart of splitOnSemicolons(cookieHeader)) {
    const part = rawPart.trim();
    if (!part) {
      continue;
    }

    const equalsIndex = part.indexOf("=");
    const name = (equalsIndex === -1 ? part : part.slice(0, equalsIndex)).trim();

    if (equalsIndex !== -1 && deniedNames.has(name)) {
      continue;
    }

    retained.push(part);
  }

  return retained.length > 0 ? retained.join("; ") : undefined;
}

function looksLikeCookieStart(value: string, start: number): boolean {
  let index = start;
  while (index < value.length && /\s/u.test(value[index])) {
    index += 1;
  }

  const nameStart = index;
  while (index < value.length && COOKIE_NAME_PATTERN.test(value[index])) {
    index += 1;
  }

  return index > nameStart && value[index] === "=";
}

export function splitCombinedSetCookieHeader(value: string): string[] {
  const cookies: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (quoted && character === "\\") {
      escaped = true;
      continue;
    }

    if (character === '"') {
      quoted = !quoted;
      continue;
    }

    if (!quoted && character === "," && looksLikeCookieStart(value, index + 1)) {
      const cookie = value.slice(start, index).trim();
      if (cookie) {
        cookies.push(cookie);
      }
      start = index + 1;
    }
  }

  const finalCookie = value.slice(start).trim();
  if (finalCookie) {
    cookies.push(finalCookie);
  }

  return cookies;
}

type ExtendedHeaders = Headers & {
  getAll?: (name: "Set-Cookie") => string[];
  getSetCookie?: () => string[];
};

export function getSetCookieValues(headers: Headers): string[] {
  const extendedHeaders = headers as ExtendedHeaders;

  if (typeof extendedHeaders.getAll === "function") {
    const values = extendedHeaders.getAll("Set-Cookie");
    if (values.length > 0) {
      return values;
    }
  }

  if (typeof extendedHeaders.getSetCookie === "function") {
    const values = extendedHeaders.getSetCookie();
    if (values.length > 0) {
      return values;
    }
  }

  const combinedValue = headers.get("Set-Cookie");
  return combinedValue ? splitCombinedSetCookieHeader(combinedValue) : [];
}

function canonicalCookieDomain(rawValue: string): string {
  let value = rawValue.trim();

  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1).trim();
  }

  return value.toLowerCase().replace(/^\.+/u, "").replace(/\.+$/u, "");
}

export function sanitizeSetCookie(value: string): string {
  const parts = splitOnSemicolons(value);
  const retained = [parts[0].trim()];

  for (const rawAttribute of parts.slice(1)) {
    const attribute = rawAttribute.trim();
    if (!attribute) {
      continue;
    }

    const equalsIndex = attribute.indexOf("=");
    const name = (equalsIndex === -1 ? attribute : attribute.slice(0, equalsIndex))
      .trim()
      .toLowerCase();
    const attributeValue = equalsIndex === -1 ? "" : attribute.slice(equalsIndex + 1);

    if (name === "domain" && canonicalCookieDomain(attributeValue) === "mlai.au") {
      continue;
    }

    retained.push(attribute);
  }

  return retained.filter(Boolean).join("; ");
}
