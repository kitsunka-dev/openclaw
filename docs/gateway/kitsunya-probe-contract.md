# Kitsunya probe contract (v1)

**Added:** OpenClaw 2026.3.31-kitsunya.1
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
  "engine_version": "2026.3.31-kitsunya.1",
  "commit":         "<sha>" | null
}
```

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

Response shape is identical across `missing-auth`, `invalid-token`, and
`rate-limited` (modulo status code + Retry-After) — no enumeration oracle.

### Non-GET

`POST` / `PUT` / `DELETE` → `405 Method Not Allowed` with `Allow: GET, HEAD`.
`HEAD` returns status + headers with an empty body.

## GET /v1/version

Authenticated version endpoint. Same auth rules as `/v1/auth/ping`.

```
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
Cache-Control: no-store

{
  "engine":  "openclaw",
  "version": "2026.3.31-kitsunya.1",
  "commit":  "<sha>" | null
}
```

401 responses match `/v1/auth/ping`'s 401 shape.

## Why this exists

Before these routes existed, `/v1/*` fell through to the Control UI SPA
catch-all and returned HTML 200 regardless of Authorization. Kitsunya's probe
classified that HTML 200 as `auth: ok` — a truth-boundary violation caught
during Kitsunya's M6 pilot walkthrough. Kitsunya landed a shape-validator at
[T2.A](https://github.com/barberdog2022-bit/kitty-front/blob/claude-tooling-setup/docs/tranche-2/t2a-audit.md)
that stopped accepting SPA HTML as auth evidence; this OpenClaw change is the
paired contract supply.

## Stability

- **Schema v1:** `{engine, authenticated}` plus optional `engine_version`, `commit`.
- Future versions may add optional fields. Existing field semantics stay stable.
- Breaking changes bump to schema v2 with an explicit endpoint alias.

## Testing

`src/gateway/server-http.probe.test.ts` covers:

- valid token → 200 + pinned shape
- missing/invalid token → 401 + `authenticated: false`
- content-type application/json on success and failure
- 405 on POST with Allow header
- HEAD returns empty body
- `/v1/auth/ping` intercepted BEFORE Control UI SPA catch-all

## Related

- Kitsunya-side contract:
  [barberdog2022-bit/kitty-front / docs/tranche-2/gateway-probe-contract.md](https://github.com/barberdog2022-bit/kitty-front/blob/claude-tooling-setup/docs/tranche-2/gateway-probe-contract.md)
- OpenClaw auth primitive: `src/gateway/auth.ts` (`authorizeHttpGatewayConnect`)
- OpenClaw probe-route registration: `src/gateway/server-http.ts` (stage
  `kitsunya-probe-contract`)
