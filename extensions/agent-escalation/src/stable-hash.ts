import { createHash } from "node:crypto";

/**
 * Local, self-contained copy of the same tiny algorithm core uses
 * (src/shared/stable-hash.ts). Extensions cannot import from src/**, so this
 * is duplicated rather than shared - it is small enough that the duplication
 * is cheaper than adding a new public plugin-sdk subpath for it.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).toSorted();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(",")}}`;
}

export function digestStable(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}
