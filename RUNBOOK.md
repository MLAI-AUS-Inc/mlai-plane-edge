# `admin.mlai.au` Plane gateway runbook

This runbook separates reversible preparation from the user-visible cutover.
Commands that change Cloudflare state require the operator to be authenticated
to the correct MLAI account and to have a second operator confirm the target.

## 1. Readiness gates

Do not attach the production route until every item below is true.

- The current `mlai-admin` repository is synchronized with its authoritative
  remote and its current routes (`/`, `/updates`, `/updates/:id`, `/review`, and
  `/logout`) have been smoke-tested.
- The old admin application's public custom domain has a tested relocation plan
  (currently proposed as `ops.mlai.au`). Keep the deployed Worker service named
  `mlai-admin`; the gateway's `LEGACY_ADMIN` binding targets that service.
- Plane runs outside the `mlai-au` Worker on a pinned release with durable
  PostgreSQL/object storage, queue/cache services, monitored workers, and tested
  backups.
- Plane's public URL is exactly `https://admin.mlai.au`. Its cookie-domain setting
  is unset so application cookies are host-only. Confirm actual cookie names on
  the pinned Plane version before cutover.
- The gateway origin is a distinct HTTPS hostname, such as
  `plane-origin.mlai.au`, which is not covered by the `admin.mlai.au/*` Worker
  route. Point it to the private Plane service through Cloudflare Tunnel.
- The named Tunnel ingress rewrites the request Host at the final origin hop:
  staging `plane-origin-staging.mlai.au` uses
  `originRequest.httpHostHeader: plane-staging.mlai.au`, and production
  `plane-origin.mlai.au` uses
  `originRequest.httpHostHeader: admin.mlai.au`. `X-Forwarded-Host` alone is not
  sufficient because Plane v1.4 uses `request.get_host()` for OAuth callbacks
  and bundled MinIO signatures.
- Direct origin access is denied. If the Tunnel hostname uses Cloudflare Access,
  create a least-privilege service token specifically for this gateway.
- Cloudflare Access protects `admin.mlai.au` with the approved staff allowlist.
  The `CF_Authorization` cookie remains in `ADDITIONAL_DENIED_COOKIES` so it does
  not reach Plane.
- The AGPL source-offer and attribution workflow for the separately deployed
  Plane fork has passed legal review. This gateway does not satisfy that
  obligation on Plane's behalf.

## 2. Prepare and verify staging

1. Install and check the exact locked dependencies:

   ```sh
   bun install --frozen-lockfile
   bun run cf-typegen
   bun run check
   ```

2. Replace the staging `PLANE_ORIGIN_URL` placeholder with the non-production
   Tunnel hostname. Set `PLANE_SOURCE_URL` to the exact public fork commit used
   by that deployment. Do not put credentials in either URL.

3. Configure both service-token secrets, or neither. A partial pair intentionally
   returns `503`:

   ```sh
   bunx wrangler secret put PLANE_ACCESS_CLIENT_ID --env staging
   bunx wrangler secret put PLANE_ACCESS_CLIENT_SECRET --env staging
   ```

4. Run locally with `.dev.vars`, then publish only the staging environment when
   approved:

   ```sh
   bun run dev
   bunx wrangler deploy --env staging
   ```

5. Exercise all of the following through the gateway:

   - sign-in, sign-out, session expiry, email links, and every OAuth callback;
   - workspace/project/work-item create, edit, search, comment, and attachment
     workflows;
   - live presence/notifications and other WebSocket-backed updates;
   - a multi-part upload and a streamed download large enough to expose buffering;
   - redirects with and without `Set-Cookie`; and
   - deliberate `401`, `403`, `404`, `429`, and `5xx` responses.

   For Google OAuth, inspect the provider redirect without following it and
   decode its `redirect_uri`: it must be exactly
   `https://plane-staging.mlai.au/auth/google/callback/`, never the private
   origin hostname. Generate an attachment upload and download URL through the
   staging API and assert both URL hosts are `plane-staging.mlai.au`; upload and
   download a disposable file through those generated URLs.

6. At a controlled staging origin, inspect cookie *names only*. Prove that
   `access_token`, `refresh_token`, `sessionid`, and `CF_Authorization` are absent,
   while the pinned Plane version's required cookies are present. Never log or
   echo cookie values.

7. Confirm every returned Plane cookie is host-only. A response must not contain
   `Domain=mlai.au` or `Domain=.mlai.au`, regardless of case.

## 3. Prepare production without routing traffic

1. Set production `PLANE_ORIGIN_URL` to the verified, distinct HTTPS Tunnel
   origin and `PLANE_SOURCE_URL` to the reviewed exact public fork commit. Leave
   `ROUTING_MODE` as `legacy`. Independently inspect the named Tunnel config and
   prove its `httpHostHeader` is exactly `admin.mlai.au` before uploading the
   candidate.

2. Verify `LEGACY_ADMIN` still targets the deployed `mlai-admin` service.

3. Configure the production service-token secrets interactively:

   ```sh
   bunx wrangler secret put PLANE_ACCESS_CLIENT_ID --env production
   bunx wrangler secret put PLANE_ACCESS_CLIENT_SECRET --env production
   ```

4. Regenerate types and rerun all gates after any Wrangler change:

   ```sh
   bun run cf-typegen
   bun run check
   git diff --check
   ```

5. Upload a production Worker version without attaching its route:

   ```sh
   bunx wrangler versions upload --env production --message "legacy-safe gateway candidate"
   ```

   Record the immutable version ID in the change ticket. `versions upload` does
   not perform the `admin.mlai.au` route cutover.

## 4. Install the gateway in legacy mode

This is the first user-visible change. Schedule it as a reviewed change with an
operator ready to restore the old custom domain.

1. Verify the production candidate reports `ROUTING_MODE=legacy` in its version
   settings and that the Plane origin is not `.invalid`.

2. Remove `admin.mlai.au` as a custom domain from the old `mlai-admin` Worker.
   Do not delete or rename that Worker; the service binding still needs it.

3. Attach the `admin.mlai.au/*` route by deploying the gateway's production
   environment:

   ```sh
   bunx wrangler deploy --env production --strict \
     --message "install gateway in legacy rollback mode"
   ```

4. Immediately verify the existing admin UI, authenticated loaders/actions,
   static assets, redirects, and logout. In legacy mode the gateway intentionally
   forwards MLAI auth cookies to the trusted `mlai-admin` binding and preserves
   its distinct parent-domain `Set-Cookie` deletion fields. Confirm `/logout`
   clears `access_token`, `refresh_token`, and `sessionid` in a fresh browser.

5. If this validation fails, remove the gateway route and restore the old custom
   domain. Plane has not received traffic yet.

## 5. Plane cutover

1. Reconfirm the latest database backup and restore evidence, Plane worker health,
   queue depth, object-store access, Tunnel health, and Access policy.

2. Change only production `ROUTING_MODE` from `legacy` to `plane`. Review the
   diff, regenerate types, and run `bun run check`.

3. Deploy with a descriptive version message:

   ```sh
   bunx wrangler deploy --env production --strict \
     --message "route admin.mlai.au to Plane"
   ```

4. Run the staging smoke suite against production with approved test accounts.
   Specifically confirm WebSockets, uploads, OAuth redirects, multiple response
   cookies, `X-Robots-Tag`, `X-Frame-Options: DENY`, and host-only Plane cookies.
   Decode the generated OAuth `redirect_uri` and signed upload/download URLs;
   every host must be `admin.mlai.au`, never `plane-origin.mlai.au`. Fetch
   `/.well-known/mlai-source` and confirm it names the deployed commit.

5. Monitor gateway `5xx`, Tunnel/origin errors, authentication failures,
   WebSocket disconnects, and Plane queue latency using aggregate route/status
   metrics. Persistent Workers logs and invocation logs are deliberately disabled:
   Cloudflare invocation logs include the full request URL, so callback codes or
   magic-link tokens could otherwise be retained. If request-level diagnostics are
   ever added, use a sanitizing Tail Worker that discards query strings and all
   cookie, authorization, and token values before persistence.

## 6. Fast rollback after cutover

The rollback does not require DNS propagation and does not reattach the old
custom domain.

1. Change `ROUTING_MODE` to `legacy`, review that this is the only behavioral
   config change, and deploy:

   ```sh
   bun run check
   bunx wrangler deploy --env production --strict \
     --message "rollback Plane to legacy admin"
   ```

2. Verify the legacy UI and authentication through the existing gateway route.

3. Preserve Plane data and logs for diagnosis. Do not destroy the Plane service,
   database, queue, cache, or object storage during rollback.

4. If the gateway itself is the failure domain, remove its route and temporarily
   restore the old Worker's custom domain. This is the slower fallback.

## 7. Failure interpretation

| Symptom | Meaning / first check |
| --- | --- |
| Gateway `503` | Invalid mode/origin, missing legacy binding, or incomplete origin service-token pair. Check binding metadata, never secret values. |
| Gateway `502` | Bound service/origin fetch threw. Check Tunnel, Access service-token validity, Plane health, and network policy. |
| Login loops | Verify Plane public URL/callbacks, Access policy, host-only cookie flags, and clock skew. |
| Plane session missing | Confirm its cookie name does not collide with the exact MLAI/additional denylist. |
| WebSocket fails | Verify Cloudflare WebSockets, Tunnel support, origin upgrade handling, and that no intermediary buffers the `101`. |
| Upload fails | Check Cloudflare plan request-size limits, origin limits, timeouts, and Plane object storage. The Worker does not buffer the body. |
| OAuth or signed URL names the origin | Roll back or block cutover. Restore the named Tunnel's exact `originRequest.httpHostHeader` public-host rewrite and rerun OAuth/upload acceptance. |
| Parent-domain cookie appears in response | Roll back immediately and capture header names/attributes only. Do not capture values. |

## 8. Routine maintenance

- Run `bun update` only in a reviewed dependency change; commit the resulting
  `bun.lock` together with test evidence.
- Run `bun run cf-typegen` whenever Wrangler bindings or compatibility dates
  change, and review the generated runtime version.
- Re-run the full cookie, OAuth, upload, redirect, streaming, and WebSocket suite
  whenever Plane changes version or cookie behavior.
- Rotate the origin service token on a scheduled cadence and immediately after
  any suspected exposure. Overlap tokens if the Access policy permits safe
  zero-downtime rotation.
- Audit `ADDITIONAL_DENIED_COOKIES` whenever MLAI introduces a new
  `Domain=.mlai.au` credential.
- Keep the legacy Worker deployable until the agreed rollback window ends; then
  replace the binding rollback with a separately approved recovery strategy.
