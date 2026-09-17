import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "../system-prompt-cache-boundary.js";
import { applyAnthropicEphemeralCacheControlMarkers } from "./anthropic-cache-control-payload.js";

describe("applyAnthropicEphemeralCacheControlMarkers", () => {
  it("marks system text content as ephemeral and strips thinking cache markers", () => {
    const payload = {
      messages: [
        { role: "system", content: "system prompt" },
        {
          role: "assistant",
          content: [
            { type: "thinking", text: "draft", cache_control: { type: "ephemeral" } },
            { type: "text", text: "answer" },
          ],
        },
      ],
    } satisfies Record<string, unknown>;

    applyAnthropicEphemeralCacheControlMarkers(payload);

    expect(payload.messages).toEqual([
      {
        role: "system",
        content: [{ type: "text", text: "system prompt", cache_control: { type: "ephemeral" } }],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "draft" },
          { type: "text", text: "answer" },
        ],
      },
    ]);
  });

  it("splits cached stable content from uncached dynamic content on string system messages", () => {
    const payload = {
      messages: [
        {
          role: "system",
          content: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic lab suffix`,
        },
        { role: "user", content: "Hello" },
      ],
    } satisfies Record<string, unknown>;

    applyAnthropicEphemeralCacheControlMarkers(payload);

    expect(payload.messages[0]).toEqual({
      role: "system",
      content: [
        { type: "text", text: "Stable prefix", cache_control: { type: "ephemeral" } },
        { type: "text", text: "Dynamic lab suffix" },
      ],
    });
  });

  it("splits cached stable content from uncached dynamic content on array developer messages", () => {
    const payload = {
      messages: [
        {
          role: "developer",
          content: [
            {
              type: "text",
              text: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic lab suffix`,
            },
          ],
        },
      ],
    } satisfies Record<string, unknown>;

    applyAnthropicEphemeralCacheControlMarkers(payload);

    expect(payload.messages[0]).toEqual({
      role: "developer",
      content: [
        { type: "text", text: "Stable prefix", cache_control: { type: "ephemeral" } },
        { type: "text", text: "Dynamic lab suffix" },
      ],
    });
  });

  it("does not leak the raw boundary marker when the dynamic suffix is empty", () => {
    const payload = {
      messages: [
        {
          role: "system",
          content: `Stable prefix only${SYSTEM_PROMPT_CACHE_BOUNDARY}`,
        },
      ],
    } satisfies Record<string, unknown>;

    applyAnthropicEphemeralCacheControlMarkers(payload);

    expect(payload.messages[0]).toEqual({
      role: "system",
      content: [{ type: "text", text: "Stable prefix only", cache_control: { type: "ephemeral" } }],
    });
  });
});
