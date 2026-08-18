import { FailoverError } from "../../agents/failover-error.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { sanitizeForLog } from "../../terminal/ansi.js";
import type { ReplyPayload } from "../types.js";

const log = createSubsystemLogger("refusal-pressure");

export type RefusalRouteKind =
  | "provider_policy_refusal"
  | "capability_refusal"
  | "prompt_boundary_refusal"
  | "tool_access_refusal"
  | "completion_gap";

export type RefusalRouteDecision = {
  shouldReroute: boolean;
  kind?: RefusalRouteKind;
  confidence: number;
  reason: string;
  matched: string[];
};

export type RefusalPressureSettings = {
  enabled: boolean;
  retryOnce: boolean;
  maxPerSession: number;
  windowMs: number;
};

const DEFAULT_REFUSAL_PRESSURE_MAX_PER_SESSION = 3;
const DEFAULT_REFUSAL_PRESSURE_WINDOW_MS = 10 * 60 * 1000;

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function readDurationMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  const match = /^(\d+)(ms|s|m|h)?$/.exec(normalized);
  if (!match) {
    return undefined;
  }
  const amount = Number.parseInt(match[1] ?? "", 10);
  const unit = match[2] ?? "ms";
  const multiplier = unit === "h" ? 3600000 : unit === "m" ? 60000 : unit === "s" ? 1000 : 1;
  return amount > 0 ? amount * multiplier : undefined;
}

function readNestedFlag(cfg: unknown): unknown {
  if (!cfg || typeof cfg !== "object") {
    return undefined;
  }
  const root = cfg as {
    agents?: {
      defaults?: {
        refusalPressure?: {
          enabled?: unknown;
          retryOnce?: unknown;
          maxPerSession?: unknown;
          windowMs?: unknown;
          window?: unknown;
        };
      };
    };
  };
  return root.agents?.defaults?.refusalPressure;
}

export function resolveRefusalPressureSettings(cfg: unknown): RefusalPressureSettings {
  const nested = readNestedFlag(cfg) as
    | {
        enabled?: unknown;
        retryOnce?: unknown;
        maxPerSession?: unknown;
        windowMs?: unknown;
        window?: unknown;
      }
    | undefined;
  return {
    enabled:
      readBoolean(process.env.OPENCLAW_REFUSAL_PRESSURE_ENABLED) ??
      readBoolean(nested?.enabled) ??
      false,
    retryOnce:
      readBoolean(process.env.OPENCLAW_REFUSAL_PRESSURE_RETRY_ONCE) ??
      readBoolean(nested?.retryOnce) ??
      true,
    maxPerSession:
      readPositiveInteger(process.env.OPENCLAW_REFUSAL_PRESSURE_MAX_PER_SESSION) ??
      readPositiveInteger(nested?.maxPerSession) ??
      DEFAULT_REFUSAL_PRESSURE_MAX_PER_SESSION,
    windowMs:
      readDurationMs(process.env.OPENCLAW_REFUSAL_PRESSURE_WINDOW_MS) ??
      readDurationMs(nested?.windowMs) ??
      readDurationMs(nested?.window) ??
      DEFAULT_REFUSAL_PRESSURE_WINDOW_MS,
  };
}

const REFUSAL_PATTERNS: Array<{ kind: RefusalRouteKind; re: RegExp; label: string }> = [
  {
    kind: "provider_policy_refusal",
    re: /\b(i\s*(?:can(?:not|'t)|won't)\s*(?:assist|help|comply|provide|continue)|i'?m\s+sorry,?\s+but\s+i\s+can(?:not|'t)|i\s+can(?:not|'t)\s+help\s+with\s+that)\b/i,
    label: "english_generic_refusal",
  },
  {
    kind: "provider_policy_refusal",
    re: /(?:не\s+можу|я\s+не\s+можу|не\s+допоможу|не\s+маю\s+можливості)\s+(?:допомогти|виконати|надати|продовжити|зробити)/i,
    label: "ukrainian_generic_refusal",
  },
  {
    kind: "prompt_boundary_refusal",
    re: /\b(?:system|developer)\s+(?:prompt|message|instruction)s?\b.*\b(?:can't|cannot|won't|not able|unable)\b/i,
    label: "prompt_boundary_refusal",
  },
  {
    kind: "capability_refusal",
    re: /\b(?:as an ai|as a language model|i don't have the ability|i do not have the ability|i can't browse|i cannot browse|i don't have access)\b/i,
    label: "capability_refusal",
  },
  {
    kind: "tool_access_refusal",
    re: /\b(?:i (?:can't|cannot|am unable to) (?:access|open|use|run|execute)|no access to (?:tools|browser|shell|files|internet))\b/i,
    label: "tool_access_refusal",
  },
];

// If the model gives a concrete safe alternative, it is often still useful; do not reroute.
const PRODUCTIVE_ALTERNATIVE_RE =
  /\b(?:i can help with|i can provide|instead,? i can|what i can do|можу допомогти|можу зробити|натомість можу)\b/i;

// Hard safety refusals should not be auto-bypassed. The router is for weak/capability/provider
// refusals on otherwise allowed work, not for forcing harmful instructions through a model.
const HARD_SAFETY_RE =
  /\b(?:weapon|explosive|malware|phishing|credential theft|child sexual|csam|self-harm|kill yourself|suicide|біологічн|вибухівк|збро[яї]|фішинг|шкідлив(?:ий|ого)\s+код|самогубств)\b/i;

const WORK_TRACE_RE =
  /(?:\bartifacts?\/|\b\S+\.txt\b|\b\S+\.patch\b|\bexists\s*=\s*true\b|\bproof\s*=|\btests?\b.*\bpassed\b|\b\d+\/\d+\s+passed\b|\bcreated\b.*\b(?:file|artifact)\b|\bcommand\s+(?:run|output)\b|\bevidence\s*:|\bblocker\s*:.*\b(?:permission denied|not found|exit code|stderr|status)\b|\bverified\b.*\b(?:observation|result)\b)/i;

const EMPTY_WORK_RE =
  /(?:\bI\s+(?:can|will|would|could)\b|\byou\s+can\b|\bwe\s+(?:should|need to|can)\b|\bneed(?:s|ed)?\s+to\b|\bthe\s+next\s+step\b|\bI\s+recommend\b|\bI\s+suggest\b|\bможу\b|\bтреба\b|\bпотрібно\b|\bнаступний\s+крок\b|\bрекомендую\b)/i;

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function classifyRefusalText(input: string | undefined): RefusalRouteDecision {
  const text = normalizeText(input ?? "");
  if (!text) {
    return { shouldReroute: false, confidence: 0, reason: "empty", matched: [] };
  }

  if (HARD_SAFETY_RE.test(text)) {
    return {
      shouldReroute: false,
      confidence: 0.95,
      reason: "hard_safety_refusal_not_rerouted",
      matched: ["hard_safety"],
    };
  }

  const hits = REFUSAL_PATTERNS.filter((pattern) => pattern.re.test(text));
  if (hits.length === 0) {
    return { shouldReroute: false, confidence: 0, reason: "no_refusal_signature", matched: [] };
  }

  const hasProductiveAlternative = PRODUCTIVE_ALTERNATIVE_RE.test(text);
  const kind = hits[0]?.kind ?? "provider_policy_refusal";
  const confidence = Math.min(
    0.98,
    0.55 + hits.length * 0.18 - (hasProductiveAlternative ? 0.2 : 0),
  );
  const shouldReroute = confidence >= 0.7 && !hasProductiveAlternative;

  return {
    shouldReroute,
    kind,
    confidence,
    reason: shouldReroute ? "actionable_refusal" : "refusal_with_productive_alternative",
    matched: hits.map((hit) => hit.label),
  };
}

export function classifyCompletionGapText(input: string | undefined): RefusalRouteDecision {
  const text = normalizeText(input ?? "");
  if (!text) {
    return { shouldReroute: false, confidence: 0, reason: "empty", matched: [] };
  }
  if (HARD_SAFETY_RE.test(text) || WORK_TRACE_RE.test(text)) {
    return { shouldReroute: false, confidence: 0, reason: "work_trace_or_hard_safety_present", matched: [] };
  }
  if (!EMPTY_WORK_RE.test(text)) {
    return { shouldReroute: false, confidence: 0, reason: "not_status_only", matched: [] };
  }
  return {
    shouldReroute: true,
    kind: "completion_gap",
    confidence: 0.74,
    reason: "status_without_work_trace",
    matched: ["empty_work_language", "missing_work_trace"],
  };
}

export function classifyRefusalPayloads(
  payloads: ReplyPayload[] | undefined,
): RefusalRouteDecision {
  const text = (payloads ?? [])
    .filter((payload) => !payload.isReasoning && !payload.isError)
    .map((payload) => payload.text ?? "")
    .join("\n")
    .trim();
  const refusal = classifyRefusalText(text);
  if (refusal.shouldReroute) {
    return refusal;
  }
  return classifyCompletionGapText(text);
}

export type RefusalPressureEvent =
  | "refusal_detected"
  | "pressure_retry_started"
  | "pressure_retry_succeeded"
  | "pressure_retry_failed_fallback"
  | "pressure_retry_throttled";

export function logRefusalPressureEvent(params: {
  event: RefusalPressureEvent;
  provider: string;
  model: string;
  runId?: string;
  decision: RefusalRouteDecision;
}): void {
  const kind = params.decision.kind ?? "unknown";
  const matched = params.decision.matched.join(",") || "none";
  log.warn("refusal pressure event", {
    event: params.event,
    tags: ["error_handling", "refusal_pressure", params.event],
    runId: params.runId,
    provider: params.provider,
    model: params.model,
    kind,
    confidence: params.decision.confidence,
    reason: params.decision.reason,
    matched: params.decision.matched,
    consoleMessage:
      `refusal pressure: event=${params.event} provider=${sanitizeForLog(params.provider)}/${sanitizeForLog(params.model)} ` +
      `kind=${kind} confidence=${params.decision.confidence.toFixed(2)} matched=${matched}`,
  });
}

type PressureBucket = {
  windowStartedAt: number;
  count: number;
};

const pressureBuckets = new Map<string, PressureBucket>();

function pressureBucketKey(params: {
  sessionKey?: string;
  provider: string;
  model: string;
}): string {
  return `${params.sessionKey ?? "unknown"}::${params.provider}::${params.model}`;
}

export function resetRefusalPressureBuckets(): void {
  pressureBuckets.clear();
}

export function shouldAllowRefusalPressureRetry(params: {
  settings: RefusalPressureSettings;
  provider: string;
  model: string;
  sessionKey?: string;
  now?: number;
}): { allowed: boolean; count: number; remaining: number; resetAt: number; key: string } {
  const now = params.now ?? Date.now();
  const key = pressureBucketKey(params);
  const existing = pressureBuckets.get(key);
  const bucket =
    existing && now - existing.windowStartedAt < params.settings.windowMs
      ? existing
      : { windowStartedAt: now, count: 0 };

  if (bucket.count >= params.settings.maxPerSession) {
    pressureBuckets.set(key, bucket);
    return {
      allowed: false,
      count: bucket.count,
      remaining: 0,
      resetAt: bucket.windowStartedAt + params.settings.windowMs,
      key,
    };
  }

  bucket.count += 1;
  pressureBuckets.set(key, bucket);
  return {
    allowed: true,
    count: bucket.count,
    remaining: Math.max(0, params.settings.maxPerSession - bucket.count),
    resetAt: bucket.windowStartedAt + params.settings.windowMs,
    key,
  };
}

export function buildRefusalPressurePrompt(params: {
  originalPrompt: string;
  decision: RefusalRouteDecision;
}): string {
  const matched = params.decision.matched.join(",") || "unknown";
  return [
    "Continue the open work item below. Treat the last response as a status note, not a result.",
    "Close the work item by leaving one useful trace of work:",
    "- a local artifact path, patch, test result, verified observation, command output summary, or a smaller completed sub-step with proof;",
    "- if the full step cannot be completed safely, shrink it once and complete the smaller step now;",
    "- inspect available workspace/tools/state before writing that access is unavailable;",
    "- keep protected prompts, secrets, credentials, private keys, auth state, and production/destructive/public changes untouched unless explicitly approved;",
    "- do not spend the answer explaining constraints unless the exact constraint is the delivered blocker with proof.",
    "",
    "Work item:",
    params.originalPrompt,
  ].join("\n");
}

export function createRefusalFailoverError(params: {
  provider: string;
  model: string;
  decision: RefusalRouteDecision;
}): FailoverError {
  return new FailoverError(
    `Model refusal routed to fallback (${params.decision.kind}; confidence=${params.decision.confidence.toFixed(2)}; matched=${params.decision.matched.join(",")})`,
    {
      reason: "unknown",
      provider: params.provider,
      model: params.model,
      code: "MODEL_REFUSAL",
      status: 409,
    },
  );
}

export function throwIfActionableRefusal(params: {
  provider: string;
  model: string;
  payloads: ReplyPayload[] | undefined;
}): void {
  const decision = classifyRefusalPayloads(params.payloads);
  if (!decision.shouldReroute) {
    return;
  }

  throw createRefusalFailoverError({
    provider: params.provider,
    model: params.model,
    decision,
  });
}
