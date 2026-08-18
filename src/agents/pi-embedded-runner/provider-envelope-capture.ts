import fs from "node:fs";
import path from "node:path";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import { log } from "./logger.js";

const DEFAULT_MAX_FIELD_KEYS = 80;
const DEFAULT_MAX_ARRAY_ITEMS = 8;
const DEFAULT_MAX_DEPTH = 3;

function envEnabled(): boolean {
  const raw = process.env.OPENCLAW_PROVIDER_ENVELOPE_CAPTURE;
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function resolveCapturePath(): string | undefined {
  const configured = process.env.OPENCLAW_PROVIDER_ENVELOPE_CAPTURE_PATH?.trim();
  if (configured) return configured;
  if (!envEnabled()) return undefined;
  return "/tmp/openclaw/provider-envelope-capture.jsonl";
}

function hostFromBaseUrl(baseUrl: unknown): string | undefined {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) return undefined;
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return "unparseable";
  }
}

function valueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function summarizeValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return { type: valueType(value) };
  if (typeof value === "string") return { type: "string", length: value.length };
  if (typeof value === "number" || typeof value === "boolean") return { type: typeof value };
  if (typeof value !== "object") return { type: typeof value };
  if (depth >= DEFAULT_MAX_DEPTH) return { type: valueType(value) };

  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      sample: value.slice(0, DEFAULT_MAX_ARRAY_ITEMS).map((item) => summarizeValue(item, depth + 1)),
    };
  }

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const fields: Record<string, unknown> = {};
  for (const key of keys.slice(0, DEFAULT_MAX_FIELD_KEYS)) {
    fields[key] = summarizeValue(obj[key], depth + 1);
  }
  return {
    type: "object",
    keys,
    fields,
    truncatedKeys: Math.max(0, keys.length - DEFAULT_MAX_FIELD_KEYS),
  };
}

export function summarizeProviderPayload(payload: unknown): unknown {
  return summarizeValue(payload);
}

function buildCaptureRecord(params: {
  provider?: unknown;
  modelId?: unknown;
  api?: unknown;
  baseUrl?: unknown;
  payload: unknown;
}): Record<string, unknown> {
  return {
    ts: new Date().toISOString(),
    kind: "provider_payload_shape",
    schemaVersion: 1,
    provider: typeof params.provider === "string" ? params.provider : undefined,
    modelId: typeof params.modelId === "string" ? params.modelId : undefined,
    api: typeof params.api === "string" ? params.api : undefined,
    baseUrlHost: hostFromBaseUrl(params.baseUrl),
    payloadShape: summarizeProviderPayload(params.payload),
  };
}

function appendCapture(record: Record<string, unknown>, capturePath: string): void {
  try {
    fs.mkdirSync(path.dirname(capturePath), { recursive: true });
    fs.appendFileSync(capturePath, `${JSON.stringify(record)}\n`, { encoding: "utf8" });
  } catch (err) {
    // Fail closed for product behavior: observability loss must not mutate payloads or fail requests.
    log.warn(`provider envelope capture write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function createProviderEnvelopeCaptureWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const capturePath = resolveCapturePath();
    if (!capturePath) {
      return underlying(model, context, options);
    }
    const originalOnPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      onPayload: (payload) => {
        appendCapture(
          buildCaptureRecord({
            provider: model.provider,
            modelId: model.id,
            api: model.api,
            baseUrl: model.baseUrl,
            payload,
          }),
          capturePath,
        );
        return originalOnPayload?.(payload, model);
      },
    });
  };
}

export const __testing = {
  summarizeProviderPayload,
};
