import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const chatHistoryMock = vi.fn<(sessionKey: string) => Promise<{ messages?: Array<unknown> }>>(
  async (_sessionKey: string) => ({ messages: [] }),
);

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async (request: unknown) => {
    const typed = request as { method?: string; params?: { sessionKey?: string } };
    if (typed.method === "chat.history") {
      return await chatHistoryMock(typed.params?.sessionKey ?? "");
    }
    return {};
  }),
}));

describe("captureSubagentCompletionReply", () => {
  let previousFastTestEnv: string | undefined;
  let previousProfileRootEnv: string | undefined;
  let captureSubagentCompletionReply: (typeof import("./subagent-announce.js"))["captureSubagentCompletionReply"];
  let tempRoot: string;

  async function loadFreshSubagentAnnounceModuleForTest() {
    vi.resetModules();
    ({ captureSubagentCompletionReply } = await import("./subagent-announce.js"));
  }

  beforeAll(async () => {
    previousFastTestEnv = process.env.OPENCLAW_TEST_FAST;
    previousProfileRootEnv = process.env.OPENCLAW_PROFILE_ROOT;
    process.env.OPENCLAW_TEST_FAST = "1";
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-subagent-capture-"));
    process.env.OPENCLAW_PROFILE_ROOT = tempRoot;
  });

  afterAll(() => {
    if (previousFastTestEnv === undefined) {
      delete process.env.OPENCLAW_TEST_FAST;
    } else {
      process.env.OPENCLAW_TEST_FAST = previousFastTestEnv;
    }
    if (previousProfileRootEnv === undefined) {
      delete process.env.OPENCLAW_PROFILE_ROOT;
    } else {
      process.env.OPENCLAW_PROFILE_ROOT = previousProfileRootEnv;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await loadFreshSubagentAnnounceModuleForTest();
    chatHistoryMock.mockReset().mockResolvedValue({ messages: [] });
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.mkdirSync(path.join(tempRoot, "subagents"), { recursive: true });
    fs.mkdirSync(path.join(tempRoot, ".claude", "projects", "workspace"), { recursive: true });
  });

  it("returns immediate assistant output from history without polling", async () => {
    chatHistoryMock.mockResolvedValueOnce({
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Immediate assistant completion" }],
        },
      ],
    });

    const result = await captureSubagentCompletionReply("agent:main:subagent:child");

    expect(result).toBe("Immediate assistant completion");
    expect(chatHistoryMock).toHaveBeenCalledTimes(1);
  });

  it("polls briefly and returns late tool output once available", async () => {
    vi.useFakeTimers();
    chatHistoryMock
      .mockResolvedValueOnce({ messages: [] })
      .mockResolvedValueOnce({ messages: [] })
      .mockResolvedValueOnce({
        messages: [
          {
            role: "toolResult",
            content: [
              {
                type: "text",
                text: "Late tool result completion",
              },
            ],
          },
        ],
      });

    const pending = captureSubagentCompletionReply("agent:main:subagent:child");
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result).toBe("Late tool result completion");
    expect(chatHistoryMock).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it("returns undefined when no completion output arrives before retry window closes", async () => {
    vi.useFakeTimers();
    chatHistoryMock.mockResolvedValue({ messages: [] });

    const pending = captureSubagentCompletionReply("agent:main:subagent:child");
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result).toBeUndefined();
    expect(chatHistoryMock).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("returns partial assistant progress when the latest assistant turn is tool-only", async () => {
    chatHistoryMock.mockResolvedValueOnce({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Mapped the modules." },
            { type: "toolCall", id: "call-1", name: "read", arguments: {} },
          ],
        },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call-2", name: "exec", arguments: {} }],
        },
      ],
    });

    const result = await captureSubagentCompletionReply("agent:main:subagent:child");

    expect(result).toBe("Mapped the modules.");
  });

  it("falls back to Claude CLI project logs when local transcript is missing", async () => {
    const sessionKey = "agent:opus:subagent:child";
    const createdAt = Date.now();
    fs.writeFileSync(
      path.join(tempRoot, "subagents", "runs.json"),
      JSON.stringify([
        {
          childSessionKey: sessionKey,
          task: "Presence ping only. Reply in one short line.",
          createdAt,
          endedAt: createdAt + 2_000,
        },
      ]),
    );
    const claudeLog = [
      JSON.stringify({
        type: "user",
        timestamp: new Date(createdAt + 50).toISOString(),
        message: {
          role: "user",
          content: "[Subagent Task]: Presence ping only. Reply in one short line.",
        },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: new Date(createdAt + 400).toISOString(),
        message: {
          role: "assistant",
          content: "Available. Claude Opus 4.6, running as subagent in OpenClaw workspace.",
        },
      }),
    ].join("\n");
    const claudeLogPath = path.join(
      tempRoot,
      ".claude",
      "projects",
      "workspace",
      "089a131c-f8f9-4819-8ac0-0388d44f57fa.jsonl",
    );
    fs.writeFileSync(claudeLogPath, claudeLog);
    fs.utimesSync(claudeLogPath, createdAt / 1000, createdAt / 1000);
    process.env.HOME = tempRoot;

    const result = await captureSubagentCompletionReply(sessionKey);

    expect(result).toBe("Available. Claude Opus 4.6, running as subagent in OpenClaw workspace.");
  });
});
