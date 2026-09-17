import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runPluginCommandWithTimeout } from "openclaw/plugin-sdk/run-command";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVerifyTaskTool, resetVerifyTaskTrackingForTest } from "./verify-task-tool.js";

vi.mock("openclaw/plugin-sdk/run-command", () => ({
  runPluginCommandWithTimeout: vi.fn(),
}));

const runPluginCommandWithTimeoutMock = vi.mocked(runPluginCommandWithTimeout);

describe("verify_task tool", () => {
  beforeEach(() => {
    resetVerifyTaskTrackingForTest();
    runPluginCommandWithTimeoutMock.mockReset();
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

  it("auto-escalates and logs when the same conditions fail twice in a row", async () => {
    const errors: string[] = [];
    const tool = createVerifyTaskTool({
      agentSessionKey: "session-c",
      logger: { error: (message) => errors.push(message) },
    });
    const conditions = [{ description: "response status is 200", met: false }];

    const first = await tool.execute("call-1", { taskType: "api_call", conditions });
    expect(first.details).toMatchObject({ status: "unmet", repeatCount: 1 });
    expect(errors).toHaveLength(0);

    const second = await tool.execute("call-2", { taskType: "api_call", conditions });
    expect(second.details).toMatchObject({ status: "unmet", repeatCount: 2 });
    const escalation = (second.details as { escalation?: { status: string; reason: string } })
      .escalation;
    expect(escalation?.status).toBe("escalated");
    expect(escalation?.reason).toContain("api_call");
    expect(escalation?.reason).toContain("response status is 200");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("auto-escalated");
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

  describe("checkId deterministic conditions (mocked)", () => {
    it("resolves met:true from a git_diff_nonempty check that reports changes", async () => {
      runPluginCommandWithTimeoutMock.mockResolvedValue({ code: 1, stdout: "", stderr: "" });
      const tool = createVerifyTaskTool({
        agentSessionKey: "session-check-a",
        workspaceDir: "/fake/workspace",
      });

      const result = await tool.execute("call-1", {
        taskType: "file_edit",
        conditions: [
          { description: "workspace has uncommitted changes", checkId: "git_diff_nonempty" },
        ],
      });

      expect(runPluginCommandWithTimeoutMock).toHaveBeenCalledWith({
        argv: ["git", "diff", "--quiet"],
        timeoutMs: 15_000,
        cwd: "/fake/workspace",
      });
      expect(result.details).toMatchObject({
        status: "verified",
        conditions: [
          {
            description: "workspace has uncommitted changes",
            met: true,
            checkId: "git_diff_nonempty",
          },
        ],
      });
    });

    it("resolves met:false from a git_diff_nonempty check that reports a clean tree", async () => {
      runPluginCommandWithTimeoutMock.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
      const tool = createVerifyTaskTool({ workspaceDir: "/fake/workspace" });

      const result = await tool.execute("call-1", {
        taskType: "file_edit",
        conditions: [
          { description: "workspace has uncommitted changes", checkId: "git_diff_nonempty" },
        ],
      });

      expect(result.details).toMatchObject({ status: "unmet" });
    });

    it("throws instead of guessing when the check exits with an unexpected code", async () => {
      runPluginCommandWithTimeoutMock.mockResolvedValue({
        code: 128,
        stdout: "",
        stderr: "fatal: not a git repository",
      });
      const tool = createVerifyTaskTool({ workspaceDir: "/fake/workspace" });

      await expect(
        tool.execute("call-1", {
          taskType: "file_edit",
          conditions: [
            { description: "workspace has uncommitted changes", checkId: "git_diff_nonempty" },
          ],
        }),
      ).rejects.toThrow("not a git repository");
    });

    it("throws on a check timeout instead of treating it as met/unmet", async () => {
      runPluginCommandWithTimeoutMock.mockResolvedValue({
        code: 1,
        stdout: "",
        stderr: "command timed out after 15000ms",
      });
      const tool = createVerifyTaskTool({ workspaceDir: "/fake/workspace" });

      await expect(
        tool.execute("call-1", {
          taskType: "file_edit",
          conditions: [
            { description: "workspace has uncommitted changes", checkId: "git_diff_nonempty" },
          ],
        }),
      ).rejects.toThrow("timed out");
    });

    it("throws when checkId is set without a known workspace directory", async () => {
      const tool = createVerifyTaskTool();

      await expect(
        tool.execute("call-1", {
          taskType: "file_edit",
          conditions: [
            { description: "workspace has uncommitted changes", checkId: "git_diff_nonempty" },
          ],
        }),
      ).rejects.toThrow("workspace directory");
      expect(runPluginCommandWithTimeoutMock).not.toHaveBeenCalled();
    });

    it("rejects an unknown checkId", async () => {
      const tool = createVerifyTaskTool({ workspaceDir: "/fake/workspace" });

      await expect(
        tool.execute("call-1", {
          taskType: "file_edit",
          conditions: [{ description: "d", checkId: "rm_rf_everything" }],
        }),
      ).rejects.toThrow("checkId must be one of");
    });

    it("rejects met or evidence supplied together with checkId", async () => {
      const tool = createVerifyTaskTool({ workspaceDir: "/fake/workspace" });

      await expect(
        tool.execute("call-1", {
          taskType: "file_edit",
          conditions: [{ description: "d", checkId: "git_diff_nonempty", met: true }],
        }),
      ).rejects.toThrow("must not include met/evidence together with checkId");

      await expect(
        tool.execute("call-1", {
          taskType: "file_edit",
          conditions: [{ description: "d", checkId: "git_diff_nonempty", evidence: "trust me" }],
        }),
      ).rejects.toThrow("must not include met/evidence together with checkId");
    });
  });

  describe("checkId deterministic conditions (real git process)", () => {
    let dir: string;

    // Proves the exit-code interpretation (0 = clean, 1 = dirty) against a
    // real `git diff --quiet` invocation, not just a mocked return value.
    // The module mock stays in place; its implementation now shells out for
    // real instead of returning a canned result, so this exercises the
    // actual argv/cwd wiring plus real git's actual exit codes.
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-escalation-verify-task-"));
      execFileSync("git", ["init", "--quiet"], { cwd: dir });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
      fs.writeFileSync(path.join(dir, "file.txt"), "hello\n");
      execFileSync("git", ["add", "file.txt"], { cwd: dir });
      execFileSync("git", ["commit", "--quiet", "-m", "init"], { cwd: dir });

      runPluginCommandWithTimeoutMock.mockImplementation(async ({ argv, cwd }) => {
        try {
          execFileSync(argv[0], argv.slice(1), { cwd });
          return { code: 0, stdout: "", stderr: "" };
        } catch (error) {
          const err = error as { status?: number | null; stdout?: Buffer; stderr?: Buffer };
          return {
            code: err.status ?? 1,
            stdout: err.stdout?.toString() ?? "",
            stderr: err.stderr?.toString() ?? "",
          };
        }
      });
    });

    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("is unmet against a clean real working tree", async () => {
      const tool = createVerifyTaskTool({ workspaceDir: dir });

      const result = await tool.execute("call-1", {
        taskType: "file_edit",
        conditions: [
          { description: "workspace has uncommitted changes", checkId: "git_diff_nonempty" },
        ],
      });

      expect(result.details).toMatchObject({ status: "unmet" });
    });

    it("is verified once the real working tree actually has an uncommitted change", async () => {
      fs.writeFileSync(path.join(dir, "file.txt"), "hello, changed\n");
      const tool = createVerifyTaskTool({ workspaceDir: dir });

      const result = await tool.execute("call-1", {
        taskType: "file_edit",
        conditions: [
          { description: "workspace has uncommitted changes", checkId: "git_diff_nonempty" },
        ],
      });

      expect(result.details).toMatchObject({ status: "verified" });
    });
  });
});
