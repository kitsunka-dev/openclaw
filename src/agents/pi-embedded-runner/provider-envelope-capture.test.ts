import { describe, expect, it } from "vitest";
import { __testing } from "./provider-envelope-capture.js";

describe("provider envelope capture", () => {
  it("summarizes payload shape without storing raw string content", () => {
    const summary = __testing.summarizeProviderPayload({
      model: "gpt-test",
      input: [
        {
          role: "user",
          content: "SECRET_PROMPT_SHOULD_NOT_APPEAR",
        },
      ],
      headers: {
        authorization: "Bearer SECRET_TOKEN_SHOULD_NOT_APPEAR",
      },
      temperature: 0.2,
    }) as Record<string, unknown>;

    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("SECRET_PROMPT_SHOULD_NOT_APPEAR");
    expect(serialized).not.toContain("SECRET_TOKEN_SHOULD_NOT_APPEAR");
    expect(serialized).toContain('"model"');
    expect(serialized).toContain('"input"');
    expect(serialized).toContain('"headers"');
    expect(serialized).toContain('"length"');
  });
});
