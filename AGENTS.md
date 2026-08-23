# AI agent contributor guide

Read [`README.md`](README.md) and [`RUNBOOK.md`](RUNBOOK.md) before changing
this repository. The README's security invariants are requirements, not design
suggestions.

## Repository boundary

This repository owns the Cloudflare Worker routing `admin.mlai.au` to either
the private Plane origin or the trusted legacy service binding. It does not own
the Plane application (`mlai-plane`), MLAI website (`mlai-au`), or Django API
(`mlai-backend`).

Coordinate changes involving hostnames, cookies, OAuth redirects, source links,
origin headers, framing, or cutover behavior with `mlai-plane` and the relevant
runbook owner.

## Security invariants

- Keep MLAI parent-domain authentication cookies out of the Plane origin.
- Preserve distinct `Set-Cookie` fields and host-only Plane cookies.
- Replace spoofable forwarding headers; do not append to untrusted input.
- Keep origin credentials in Wrangler secrets, never vars, source, examples,
  logs, or issue text.
- Never log request headers, cookies, origin URLs, credentials, or raw thrown
  error messages.
- Fail closed on missing, placeholder, recursive, malformed, or insecure origin
  configuration.
- Do not weaken `X-Frame-Options: DENY` without a separately reviewed security
  decision covering Plane and the edge gateway.
- Do not deploy, cut over, or execute rollback steps unless the user explicitly
  requests that external action.

## Commands

```bash
bun install --frozen-lockfile
cp .dev.vars.example .dev.vars
bun run dev
bun run check
```

Use only safe, non-production values in `.dev.vars`. `bun run check` performs
type checking, the Workerd/Vitest suite, and a Wrangler production dry run. It
does not authorize a real deployment.

For documentation-only changes, validate links and paths without starting the
Worker or contacting Cloudflare.

## Operations

`RUNBOOK.md` owns readiness, staging, production preparation, cutover, rollback,
failure interpretation, and maintenance. `ACCEPTANCE.md` records a dated
rehearsal and should not be treated as perpetual evidence of current readiness.
