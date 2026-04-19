import { describe, expect, it } from "vitest";
import {
  AUTH_TOKEN,
  AUTH_NONE,
  createRequest,
  createResponse,
  dispatchRequest,
  withGatewayServer,
} from "./server-http.test-harness.js";
import type { ReadinessChecker } from "./server/readiness.js";
import { withTempConfig } from "./test-temp-config.js";

describe("gateway OpenAI-compatible disabled HTTP routes", () => {
  it("returns 404 when compat endpoints are disabled", async () => {
    await withGatewayServer({
      prefix: "openai-compat-disabled",
      resolvedAuth: AUTH_NONE,
      run: async (server) => {
        for (const path of ["/v1/chat/completions", "/v1/responses"]) {
          const req = createRequest({
            path,
            method: "POST",
            headers: { "content-type": "application/json" },
          });
          const { res, getBody } = createResponse();
          await dispatchRequest(server, req, res);

          expect(res.statusCode, path).toBe(404);
          expect(getBody(), path).toBe("Not Found");
        }
      },
    });
  });
});

describe("gateway probe endpoints", () => {
  it("returns detailed readiness payload for local /ready requests", async () => {
    const getReadiness: ReadinessChecker = () => ({
      ready: true,
      failing: [],
      uptimeMs: 45_000,
    });

    await withGatewayServer({
      prefix: "probe-ready",
      resolvedAuth: AUTH_NONE,
      overrides: { getReadiness },
      run: async (server) => {
        const req = createRequest({ path: "/ready" });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(200);
        expect(JSON.parse(getBody())).toEqual({ ready: true, failing: [], uptimeMs: 45_000 });
      },
    });
  });

  it("returns only readiness state for unauthenticated remote /ready requests", async () => {
    const getReadiness: ReadinessChecker = () => ({
      ready: false,
      failing: ["discord", "telegram"],
      uptimeMs: 8_000,
    });

    await withGatewayServer({
      prefix: "probe-not-ready",
      resolvedAuth: AUTH_NONE,
      overrides: { getReadiness },
      run: async (server) => {
        const req = createRequest({
          path: "/ready",
          remoteAddress: "10.0.0.8",
          host: "gateway.test",
        });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(503);
        expect(JSON.parse(getBody())).toEqual({ ready: false });
      },
    });
  });

  it("returns detailed readiness payload for authenticated remote /ready requests", async () => {
    const getReadiness: ReadinessChecker = () => ({
      ready: false,
      failing: ["discord", "telegram"],
      uptimeMs: 8_000,
    });

    await withGatewayServer({
      prefix: "probe-remote-authenticated",
      resolvedAuth: AUTH_TOKEN,
      overrides: { getReadiness },
      run: async (server) => {
        const req = createRequest({
          path: "/ready",
          remoteAddress: "10.0.0.8",
          host: "gateway.test",
          authorization: "Bearer test-token",
        });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(503);
        expect(JSON.parse(getBody())).toEqual({
          ready: false,
          failing: ["discord", "telegram"],
          uptimeMs: 8_000,
        });
      },
    });
  });

  it("re-resolves auth for remote /ready requests after shared auth rotation", async () => {
    const getReadiness: ReadinessChecker = () => ({
      ready: false,
      failing: ["discord", "telegram"],
      uptimeMs: 8_000,
    });
    let currentAuth = AUTH_TOKEN;

    await withGatewayServer({
      prefix: "probe-remote-rotated-auth",
      // `resolvedAuth` remains the static fallback; `getResolvedAuth` drives the rotated value.
      resolvedAuth: AUTH_TOKEN,
      overrides: {
        getReadiness,
        getResolvedAuth: () => currentAuth,
      },
      run: async (server) => {
        const sendReady = async (authorization: string) => {
          const req = createRequest({
            path: "/ready",
            remoteAddress: "10.0.0.8",
            host: "gateway.test",
            authorization,
          });
          const { res, getBody } = createResponse();
          await dispatchRequest(server, req, res);
          return { statusCode: res.statusCode, body: JSON.parse(getBody()) };
        };

        await expect(sendReady("Bearer test-token")).resolves.toEqual({
          statusCode: 503,
          body: {
            ready: false,
            failing: ["discord", "telegram"],
            uptimeMs: 8_000,
          },
        });

        currentAuth = {
          ...AUTH_TOKEN,
          token: "rotated-token",
        };

        await expect(sendReady("Bearer test-token")).resolves.toEqual({
          statusCode: 503,
          body: { ready: false },
        });
        await expect(sendReady("Bearer rotated-token")).resolves.toEqual({
          statusCode: 503,
          body: {
            ready: false,
            failing: ["discord", "telegram"],
            uptimeMs: 8_000,
          },
        });
      },
    });
  });

  it("hides readiness details when trusted-proxy auth violates browser origin policy", async () => {
    const getReadiness: ReadinessChecker = () => ({
      ready: false,
      failing: ["discord", "telegram"],
      uptimeMs: 8_000,
    });

    await withTempConfig({
      prefix: "probe-remote-origin-rejected",
      cfg: {
        gateway: {
          trustedProxies: ["10.0.0.1"],
          controlUi: {
            allowedOrigins: ["https://control.example"],
          },
        },
      },
      run: async () => {
        await withGatewayServer({
          prefix: "probe-remote-origin-rejected-server",
          resolvedAuth: {
            mode: "trusted-proxy",
            allowTailscale: false,
            trustedProxy: { userHeader: "x-forwarded-user" },
          },
          overrides: {
            getReadiness,
          },
          run: async (server) => {
            const req = createRequest({
              path: "/ready",
              remoteAddress: "10.0.0.1",
              host: "gateway.test",
              headers: {
                origin: "https://evil.example",
                forwarded: "for=203.0.113.10;proto=https;host=gateway.test",
                "x-forwarded-user": "user@example.com",
                "x-forwarded-proto": "https",
              },
            });
            const { res, getBody } = createResponse();
            await dispatchRequest(server, req, res);

            expect(res.statusCode).toBe(503);
            expect(JSON.parse(getBody())).toEqual({ ready: false });
          },
        });
      },
    });
  });

  it("returns typed internal error payload when readiness evaluation throws", async () => {
    const getReadiness: ReadinessChecker = () => {
      throw new Error("boom");
    };

    await withGatewayServer({
      prefix: "probe-throws",
      resolvedAuth: AUTH_NONE,
      overrides: { getReadiness },
      run: async (server) => {
        const req = createRequest({ path: "/ready" });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(503);
        expect(JSON.parse(getBody())).toEqual({ ready: false, failing: ["internal"], uptimeMs: 0 });
      },
    });
  });

  it("keeps /healthz shallow even when readiness checker reports failing channels", async () => {
    const getReadiness: ReadinessChecker = () => ({
      ready: false,
      failing: ["discord"],
      uptimeMs: 999,
    });

    await withGatewayServer({
      prefix: "probe-healthz-unaffected",
      resolvedAuth: AUTH_NONE,
      overrides: { getReadiness },
      run: async (server) => {
        const req = createRequest({ path: "/healthz" });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(200);
        expect(getBody()).toBe(JSON.stringify({ ok: true, status: "live" }));
      },
    });
  });

  it("reflects readiness status on HEAD /readyz without a response body", async () => {
    const getReadiness: ReadinessChecker = () => ({
      ready: false,
      failing: ["discord"],
      uptimeMs: 5_000,
    });

    await withGatewayServer({
      prefix: "probe-readyz-head",
      resolvedAuth: AUTH_NONE,
      overrides: { getReadiness },
      run: async (server) => {
        const req = createRequest({ path: "/readyz", method: "HEAD" });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(503);
        expect(getBody()).toBe("");
      },
    });
  });
});

describe("Kitsunya probe contract — /v1/auth/ping", () => {
  it("returns 401 + authenticated=false on missing Authorization header", async () => {
    await withGatewayServer({
      prefix: "kitsunya-authping-no-auth",
      resolvedAuth: AUTH_TOKEN,
      run: async (server) => {
        const req = createRequest({ path: "/v1/auth/ping" });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(401);
        const body = JSON.parse(getBody());
        expect(body).toMatchObject({
          engine: "openclaw",
          authenticated: false,
        });
        expect(typeof body.error).toBe("string");
      },
    });
  });

  it("returns 401 + authenticated=false on invalid Bearer token", async () => {
    await withGatewayServer({
      prefix: "kitsunya-authping-bad-token",
      resolvedAuth: AUTH_TOKEN,
      run: async (server) => {
        const req = createRequest({
          path: "/v1/auth/ping",
          authorization: "Bearer wrong-token-definitely-not-the-real-one",
        });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(401);
        const body = JSON.parse(getBody());
        expect(body).toMatchObject({
          engine: "openclaw",
          authenticated: false,
        });
      },
    });
  });

  it("returns 200 + contract shape on valid Bearer token", async () => {
    await withGatewayServer({
      prefix: "kitsunya-authping-good",
      resolvedAuth: AUTH_TOKEN,
      run: async (server) => {
        const req = createRequest({
          path: "/v1/auth/ping",
          authorization: "Bearer test-token",
        });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(getBody());
        expect(body.engine).toBe("openclaw");
        expect(body.authenticated).toBe(true);
        // engine_version must be a non-empty string; commit is string-or-null
        expect(typeof body.engine_version).toBe("string");
        expect(body.engine_version.length).toBeGreaterThan(0);
        expect(body.commit === null || typeof body.commit === "string").toBe(true);
      },
    });
  });

  it("content-type is application/json on both success and failure", async () => {
    await withGatewayServer({
      prefix: "kitsunya-authping-ctype",
      resolvedAuth: AUTH_TOKEN,
      run: async (server) => {
        for (const auth of [undefined, "Bearer test-token"]) {
          const req = createRequest({ path: "/v1/auth/ping", authorization: auth });
          const { res, setHeader } = createResponse();
          await dispatchRequest(server, req, res);
          const ctCall = setHeader.mock.calls.find(
            (call: unknown[]) =>
              typeof call[0] === "string" && call[0].toLowerCase() === "content-type",
          );
          expect(ctCall, `content-type set (auth=${auth})`).toBeDefined();
          expect(String(ctCall?.[1])).toMatch(/application\/json/);
        }
      },
    });
  });

  it("returns 405 Method Not Allowed for POST", async () => {
    await withGatewayServer({
      prefix: "kitsunya-authping-post",
      resolvedAuth: AUTH_TOKEN,
      run: async (server) => {
        const req = createRequest({
          path: "/v1/auth/ping",
          method: "POST",
          authorization: "Bearer test-token",
        });
        const { res, setHeader } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(405);
        const allowCall = setHeader.mock.calls.find(
          (call: unknown[]) => typeof call[0] === "string" && call[0].toLowerCase() === "allow",
        );
        expect(allowCall, "Allow header set on 405").toBeDefined();
        expect(String(allowCall?.[1])).toContain("GET");
      },
    });
  });

  it("HEAD returns status + headers + empty body", async () => {
    await withGatewayServer({
      prefix: "kitsunya-authping-head",
      resolvedAuth: AUTH_TOKEN,
      run: async (server) => {
        const req = createRequest({
          path: "/v1/auth/ping",
          method: "HEAD",
          authorization: "Bearer test-token",
        });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(200);
        expect(getBody()).toBe("");
      },
    });
  });
});

describe("Kitsunya probe contract — /v1/version", () => {
  it("returns 401 on missing auth", async () => {
    await withGatewayServer({
      prefix: "kitsunya-version-no-auth",
      resolvedAuth: AUTH_TOKEN,
      run: async (server) => {
        const req = createRequest({ path: "/v1/version" });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(401);
        const body = JSON.parse(getBody());
        expect(body.engine).toBe("openclaw");
        expect(body.authenticated).toBe(false);
      },
    });
  });

  it("returns 200 + {engine, version, commit} on valid token", async () => {
    await withGatewayServer({
      prefix: "kitsunya-version-good",
      resolvedAuth: AUTH_TOKEN,
      run: async (server) => {
        const req = createRequest({
          path: "/v1/version",
          authorization: "Bearer test-token",
        });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(getBody());
        expect(body.engine).toBe("openclaw");
        expect(typeof body.version).toBe("string");
        expect(body.version.length).toBeGreaterThan(0);
        expect(body.commit === null || typeof body.commit === "string").toBe(true);
        // /v1/version omits the `authenticated` field — it's the version endpoint, not
        // the auth endpoint
        expect("authenticated" in body).toBe(false);
      },
    });
  });
});

describe("Kitsunya probe contract — routing precedence", () => {
  it("/v1/auth/ping is intercepted BEFORE control-ui SPA fallback (returns JSON, not HTML)", async () => {
    await withGatewayServer({
      prefix: "kitsunya-routing-precedence",
      resolvedAuth: AUTH_TOKEN,
      run: async (server) => {
        const req = createRequest({
          path: "/v1/auth/ping",
          authorization: "Bearer test-token",
        });
        const { res, setHeader, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        const ctCall = setHeader.mock.calls.find(
          (call: unknown[]) =>
            typeof call[0] === "string" && call[0].toLowerCase() === "content-type",
        );
        expect(String(ctCall?.[1])).toMatch(/application\/json/);
        expect(getBody()).not.toMatch(/<!doctype html/i);
      },
    });
  });
});
