# Kitsunya probe contract (v1)

**Added:** OpenClaw 2026.4.19-beta.2-kitsunya.1
**Routes:** `GET /v1/auth/ping`, `GET /v1/version`
**Consumer:** Kitsunya (github.com/barberdog2022-bit/kitty-front)

Kitsunya is an operator control plane that connects to one or more OpenClaw
installs and probes each gateway on-demand. Its probe contract requires two
HTTP routes that the gateway explicitly honors — otherwise the fallback SPA
catch-all would swallow them and probes would get no auth evidence.

## GET /v1/auth/ping

Authenticated engine-identity + auth-evidence endpoint.

### Request

```
GET /v1/auth/ping
Authorization: Bearer <gateway-token>
```

Works with any of OpenClaw's HTTP bearer token surfaces (config `gateway.auth.mode =
token` or `password`). Same rate-limiter and Tailscale-off policy as `/ws` upgrade
auth.

### Response (authenticated)

```
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
Cache-Control: no-store

{
  "engine":         "openclaw",
  "authenticated":  true,
  "engine_version": "2026.4.19-beta.2-kitsunya.1",
  "commit":         "d64defa..." | null
}
```

`engine_version` is the running binary version; `commit` is the git SHA when the
binary was built (null when unavailable — e.g. plain `npm install` outside a git
checkout).

### Response (unauthenticated / invalid token)

```
HTTP/1.1 401 Unauthorized
Content-Type: application/json; charset=utf-8
Cache-Control: no-store

{
  "engine":        "openclaw",
  "authenticated": false,
  "error":         "unauthorized" | "token_missing" | ...
}
```

### Response (rate-limited)

```
HTTP/1.1 429 Too Many Requests
Retry-After: <seconds>
Content-Type: application/json; charset=utf-8

{
  "engine":        "openclaw",
  "authenticated": false,
  "error":         "rate_limited"
}
```

The shape is **identical** across `missing-auth`, `invalid-token`, and `rate-limited`
(modulo status code + Retry-After) — no enumeration oracle for which token length or
pattern is valid.

### Non-GET

`POST` / `PUT` / `DELETE` → `405 Method Not Allowed` with `Allow: GET, HEAD`.
`HEAD` returns status + headers with an empty body (same auth check).

## GET /v1/version

Authenticated version endpoint. Same auth rules as `/v1/auth/ping`.

### Response (authenticated)

```
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
Cache-Control: no-store

{
  "engine":  "openclaw",
  "version": "2026.4.19-beta.2-kitsunya.1",
  "commit":  "d64defa..." | null
}
```

Note: this endpoint **omits** `authenticated` (that field is specific to
`/v1/auth/ping`). Callers that need auth evidence should probe `/v1/auth/ping`.

### Response (unauthenticated)

Identical shape to `/v1/auth/ping`'s 401 — `{ engine, authenticated: false, error }`.

## Why this exists

Before these routes existed, any path under `/v1/*` fell through to the Control UI
SPA catch-all and returned HTML 200 regardless of Authorization. Kitsunya's probe
at one point classified that HTML 200 as `auth: ok` — a truth-boundary violation
caught during Kitsunya's own M6 pilot walkthrough (see
[validation-findings.md](https://github.com/barberdog2022-bit/kitty-front/blob/claude-tooling-setup/docs/tranche-1/validation-findings.md)
Finding 2).

The fix could go one of two places:

1. Kitsunya side — tighten the probe response validator (landed 2026-04-19 at
   [T2.A](https://github.com/barberdog2022-bit/kitty-front/blob/claude-tooling-setup/docs/tranche-2/t2a-audit.md))
2. OpenClaw side — actually implement the expected contract

Both are needed. T2.A stopped Kitsunya from fabricating `auth: ok`. This commit
supplies the contract it was expecting.

## Stability

- **Schema v1:** `{engine, authenticated}` + optional `engine_version`, `commit`.
- Future versions may add optional fields. Existing field semantics stay stable.
- Breaking changes (removing/renaming fields, changing status code semantics)
  will bump to schema v2 with an explicit endpoint alias.

## Testing

`src/gateway/server-http.probe.test.ts` covers:

- valid token → 200 + pinned shape
- missing/invalid token → 401 + shape with `authenticated: false`
- content-type application/json on both success and failure
- 405 on POST with Allow header
- HEAD returns empty body
- `/v1/auth/ping` intercepted BEFORE Control UI SPA catch-all

## Related

- Kitsunya-side contract document:
  [barberdog2022-bit/kitty-front / docs/tranche-2/gateway-probe-contract.md](https://github.com/barberdog2022-bit/kitty-front/blob/claude-tooling-setup/docs/tranche-2/gateway-probe-contract.md)
- OpenClaw auth primitive: `src/gateway/auth.ts` (`authorizeHttpGatewayConnect`)
- OpenClaw probe-route registration: `src/gateway/server-http.ts` (stage
  `kitsunya-probe-contract`)
