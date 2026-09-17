import { beforeEach, describe, expect, it } from "vitest";
import { createVerifyTaskTool, resetVerifyTaskTrackingForTest } from "./verify-task-tool.js";

describe("verify_task tool", () => {
  beforeEach(() => {
    resetVerifyTaskTrackingForTest();
  });

  it("reports verified when every condition is met", async () => {
    const tool = createVerifyTaskTool({ agentSessionKey: "session-a" });
    const result = await tool.execute("call-1", {
      taskType: "file_edit",
      conditions: [
        { description: "file exists", met: true, evidence: "read_file returned content" },
        { description: "tests pass", met: true },
      ],
    });

    expect(result.content).toEqual([]);
    expect(result.details).toEqual({
      status: "verified",
      taskType: "file_edit",
      conditions: [
        { description: "file exists", met: true, evidence: "read_file returned content" },
        { description: "tests pass", met: true },
      ],
    });
  });

  it("reports unmet without escalation on the first failure", async () => {
    const tool = createVerifyTaskTool({ agentSessionKey: "session-b" });
    const result = await tool.execute("call-1", {
      taskType: "api_call",
      conditions: [{ description: "response status is 200", met: false }],
    });

    expect(result.details).toMatchObject({ status: "unmet", repeatCount: 1 });
    expect((result.details as { escalation?: unknown }).escalation).toBeUndefined();
  });

  it("auto-escalates when the same conditions fail twice in a row for the same session", async () => {
    const tool = createVerifyTaskTool({ agentSessionKey: "session-c" });
    const conditions = [{ description: "response status is 200", met: false }];

    const first = await tool.execute("call-1", { taskType: "api_call", conditions });
    expect(first.details).toMatchObject({ status: "unmet", repeatCount: 1 });

    const second = await tool.execute("call-2", { taskType: "api_call", conditions });
    expect(second.details).toMatchObject({ status: "unmet", repeatCount: 2 });
    const escalation = (second.details as { escalation?: { status: string; reason: string } })
      .escalation;
    expect(escalation?.status).toBe("escalated");
    expect(escalation?.reason).toContain("api_call");
    expect(escalation?.reason).toContain("response status is 200");
  });

  it("resets the streak when the unmet conditions change", async () => {
    const tool = createVerifyTaskTool({ agentSessionKey: "session-d" });

    const first = await tool.execute("call-1", {
      taskType: "api_call",
      conditions: [{ description: "response status is 200", met: false }],
    });
    expect(first.details).toMatchObject({ repeatCount: 1 });

    const second = await tool.execute("call-2", {
      taskType: "api_call",
      conditions: [{ description: "response body matches schema", met: false }],
    });
    expect(second.details).toMatchObject({ status: "unmet", repeatCount: 1 });
    expect((second.details as { escalation?: unknown }).escalation).toBeUndefined();
  });

  it("tracks separate sessions independently", async () => {
    const toolA = createVerifyTaskTool({ agentSessionKey: "session-e" });
    const toolB = createVerifyTaskTool({ agentSessionKey: "session-f" });
    const conditions = [{ description: "response status is 200", met: false }];

    await toolA.execute("call-1", { taskType: "api_call", conditions });
    const bResult = await toolB.execute("call-1", { taskType: "api_call", conditions });

    expect(bResult.details).toMatchObject({ repeatCount: 1 });
  });

  it("requires taskType and conditions", async () => {
    const tool = createVerifyTaskTool();

    await expect(tool.execute("call-1", { conditions: [] })).rejects.toThrow("taskType required");
    await expect(tool.execute("call-1", { taskType: "x" })).rejects.toThrow("conditions required");
    await expect(
      tool.execute("call-1", { taskType: "x", conditions: [{ description: "d" }] }),
    ).rejects.toThrow("met must be a boolean");
  });
});
