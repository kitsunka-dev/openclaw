import { describe, expect, it } from "vitest";
import { AgentDefaultsSchema } from "./zod-schema.agent-defaults.js";

describe("agent defaults schema", () => {
  it("accepts subagent archiveAfterMinutes=0 to disable archiving", () => {
    expect(() =>
      AgentDefaultsSchema.parse({
        subagents: {
          archiveAfterMinutes: 0,
        },
      }),
    ).not.toThrow();
  });
});

it("accepts refusalPressure defaults", () => {
  expect(() =>
    AgentDefaultsSchema.parse({
      refusalPressure: {
        enabled: true,
        retryOnce: false,
        maxPerSession: 2,
        windowMs: 60000,
        window: "10m",
      },
    }),
  ).not.toThrow();
});
