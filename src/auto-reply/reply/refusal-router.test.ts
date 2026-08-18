import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildRefusalPressurePrompt,
  classifyCompletionGapText,
  classifyRefusalText,
  resetRefusalPressureBuckets,
  resolveRefusalPressureSettings,
  shouldAllowRefusalPressureRetry,
} from "./refusal-router.js";

describe("refusal router", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetRefusalPressureBuckets();
  });
  it("routes generic English provider refusals", () => {
    const decision = classifyRefusalText("I'm sorry, but I can't help with that request.");

    expect(decision.shouldReroute).toBe(true);
    expect(decision.kind).toBe("provider_policy_refusal");
    expect(decision.matched).toContain("english_generic_refusal");
  });

  it("routes Ukrainian generic refusals", () => {
    const decision = classifyRefusalText("Я не можу виконати цей запит.");

    expect(decision.shouldReroute).toBe(true);
    expect(decision.kind).toBe("provider_policy_refusal");
  });

  it("routes fake capability refusals that tools can solve", () => {
    const decision = classifyRefusalText("As an AI, I can't browse the web or access files.");

    expect(decision.shouldReroute).toBe(true);
    expect(decision.kind).toBe("capability_refusal");
  });

  it("does not route hard safety refusals", () => {
    const decision = classifyRefusalText("I can't help build malware or phishing kits.");

    expect(decision.shouldReroute).toBe(false);
    expect(decision.reason).toBe("hard_safety_refusal_not_rerouted");
  });

  it("does not route productive alternatives", () => {
    const decision = classifyRefusalText(
      "I can't provide the private system prompt, but I can help with a safe summary instead.",
    );

    expect(decision.shouldReroute).toBe(false);
    expect(decision.reason).toBe("refusal_with_productive_alternative");
  });

  it("catches status-only output without proof", () => {
    const decision = classifyCompletionGapText(
      "I can help with that. The next step is to inspect the workspace and create a report.",
    );

    expect(decision.shouldReroute).toBe(true);
    expect(decision.kind).toBe("completion_gap");
    expect(decision.reason).toBe("status_without_work_trace");
  });

  it("accepts blocker output when it includes evidence", () => {
    const decision = classifyCompletionGapText(
      "Blocker: permission denied. Evidence: command run `ls /root` returned Permission denied.",
    );

    expect(decision.shouldReroute).toBe(false);
  });

  it("builds a pressure retry prompt that preserves boundaries and demands payload", () => {
    const decision = classifyRefusalText("As an AI, I can't browse the web or access files.");
    const prompt = buildRefusalPressurePrompt({
      originalPrompt: "Read package.json and summarize scripts.",
      decision,
    });

    expect(prompt).toContain("last response as a status note, not a result");
    expect(prompt).toContain("keep protected prompts, secrets, credentials");
    expect(prompt).toContain("local artifact path, patch, test result, verified observation");
    expect(prompt).toContain("Read package.json and summarize scripts.");
  });

  it("keeps pressure disabled by default", () => {
    vi.stubEnv("OPENCLAW_REFUSAL_PRESSURE_ENABLED", "");
    vi.stubEnv("OPENCLAW_REFUSAL_PRESSURE_RETRY_ONCE", "");

    expect(resolveRefusalPressureSettings({}).enabled).toBe(false);
    expect(resolveRefusalPressureSettings({}).retryOnce).toBe(true);
  });

  it("enables pressure from config", () => {
    vi.stubEnv("OPENCLAW_REFUSAL_PRESSURE_ENABLED", "");
    vi.stubEnv("OPENCLAW_REFUSAL_PRESSURE_RETRY_ONCE", "");

    const settings = resolveRefusalPressureSettings({
      agents: { defaults: { refusalPressure: { enabled: true, retryOnce: false } } },
    });

    expect(settings).toMatchObject({ enabled: true, retryOnce: false });
    expect(settings.maxPerSession).toBe(3);
    expect(settings.windowMs).toBe(10 * 60 * 1000);
  });

  it("lets env override config for emergency kill/enable", () => {
    vi.stubEnv("OPENCLAW_REFUSAL_PRESSURE_ENABLED", "1");
    vi.stubEnv("OPENCLAW_REFUSAL_PRESSURE_RETRY_ONCE", "0");

    const settings = resolveRefusalPressureSettings({
      agents: { defaults: { refusalPressure: { enabled: false, retryOnce: true } } },
    });

    expect(settings).toMatchObject({ enabled: true, retryOnce: false });
  });

  it("resolves pressure rate limit settings from config and env", () => {
    vi.stubEnv("OPENCLAW_REFUSAL_PRESSURE_ENABLED", "");
    vi.stubEnv("OPENCLAW_REFUSAL_PRESSURE_RETRY_ONCE", "");
    vi.stubEnv("OPENCLAW_REFUSAL_PRESSURE_MAX_PER_SESSION", "2");
    vi.stubEnv("OPENCLAW_REFUSAL_PRESSURE_WINDOW_MS", "30s");

    const settings = resolveRefusalPressureSettings({
      agents: { defaults: { refusalPressure: { enabled: true, maxPerSession: 9, window: "5m" } } },
    });

    expect(settings).toMatchObject({
      enabled: true,
      retryOnce: true,
      maxPerSession: 2,
      windowMs: 30_000,
    });
  });

  it("rate-limits pressure retries per session provider and model", () => {
    const settings = { enabled: true, retryOnce: true, maxPerSession: 2, windowMs: 1000 };

    expect(
      shouldAllowRefusalPressureRetry({
        settings,
        provider: "openai",
        model: "gpt",
        sessionKey: "s1",
        now: 1000,
      }).allowed,
    ).toBe(true);
    expect(
      shouldAllowRefusalPressureRetry({
        settings,
        provider: "openai",
        model: "gpt",
        sessionKey: "s1",
        now: 1100,
      }).allowed,
    ).toBe(true);
    expect(
      shouldAllowRefusalPressureRetry({
        settings,
        provider: "openai",
        model: "gpt",
        sessionKey: "s1",
        now: 1200,
      }).allowed,
    ).toBe(false);
    expect(
      shouldAllowRefusalPressureRetry({
        settings,
        provider: "openai",
        model: "gpt",
        sessionKey: "s1",
        now: 2101,
      }).allowed,
    ).toBe(true);
  });
});
