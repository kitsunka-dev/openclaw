import { describe, expect, it } from "vitest";
import { createEscalateToOperatorTool } from "./escalate-to-operator-tool.js";

describe("escalate_to_operator tool", () => {
  it("returns a compact escalation payload", async () => {
    const tool = createEscalateToOperatorTool();
    const result = await tool.execute("call-1", {
      reason: "The account lookup returned no match and the request did not name an ID.",
      attempted: "Searched by email and by display name.",
      question: "Which account should this be applied to?",
    });

    expect(result.content).toEqual([]);
    expect(result.details).toEqual({
      status: "escalated",
      reason: "The account lookup returned no match and the request did not name an ID.",
      attempted: "Searched by email and by display name.",
      question: "Which account should this be applied to?",
    });
  });

  it("requires a reason", async () => {
    const tool = createEscalateToOperatorTool();

    await expect(tool.execute("call-1", {})).rejects.toThrow("reason required");
  });

  it("omits optional fields when not provided", async () => {
    const tool = createEscalateToOperatorTool();
    const result = await tool.execute("call-1", {
      reason: "Outside my authority - this changes billing configuration.",
    });

    expect(result.details).toEqual({
      status: "escalated",
      reason: "Outside my authority - this changes billing configuration.",
    });
  });
});
