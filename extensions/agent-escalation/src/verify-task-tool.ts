import { Type } from "@sinclair/typebox";
import { readStringParam } from "openclaw/plugin-sdk/param-readers";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { runPluginCommandWithTimeout } from "openclaw/plugin-sdk/run-command";
import { buildEscalationRecord, type EscalationRecord } from "./escalate-to-operator-tool.js";
import { digestStable } from "./stable-hash.js";

/**
 * Deterministic checks the tool runs itself instead of trusting the agent's
 * self-reported `met`. Each maps to one fixed argv (never a shell string, and
 * never agent-supplied) so this cannot become an arbitrary-command backdoor
 * around the repo's own exec security policy - the set of possible commands
 * is closed and defined here, not by tool input.
 */
const DETERMINISTIC_CHECK_TIMEOUT_MS = 15_000;

type DeterministicCheckId = "git_diff_nonempty";
const DETERMINISTIC_CHECK_IDS = ["git_diff_nonempty"] as const satisfies readonly [
  DeterministicCheckId,
];
const deterministicCheckIdSet = new Set<string>(DETERMINISTIC_CHECK_IDS);

function isDeterministicCheckId(value: unknown): value is DeterministicCheckId {
  return typeof value === "string" && deterministicCheckIdSet.has(value);
}

async function runGitDiffNonemptyCheck(
  workspaceDir: string,
): Promise<{ met: boolean; evidence: string }> {
  const result = await runPluginCommandWithTimeout({
    argv: ["git", "diff", "--quiet"],
    timeoutMs: DETERMINISTIC_CHECK_TIMEOUT_MS,
    cwd: workspaceDir,
  });
  if (result.stderr.includes("command timed out after")) {
    throw new Error(`git_diff_nonempty check timed out: ${result.stderr}`);
  }
  if (result.code === 0) {
    return { met: false, evidence: "git diff --quiet exited 0: working tree is clean." };
  }
  if (result.code === 1) {
    return {
      met: true,
      evidence: "git diff --quiet exited 1: working tree has uncommitted changes.",
    };
  }
  throw new Error(
    `git_diff_nonempty check could not run (exit ${result.code}): ${
      result.stderr || result.stdout || "no output"
    }`,
  );
}

const DETERMINISTIC_CHECKS: Record<
  DeterministicCheckId,
  (workspaceDir: string) => Promise<{ met: boolean; evidence: string }>
> = {
  git_diff_nonempty: runGitDiffNonemptyCheck,
};

const VerifyConditionSchema = Type.Object(
  {
    description: Type.String({
      description: "One concrete, checkable condition for this task to count as done.",
    }),
    met: Type.Optional(
      Type.Boolean({
        description:
          "Whether you confirmed this condition is true - not whether you expect it to be. Required unless checkId is set; omit it when checkId is set (the tool computes it, and rejects met/evidence being supplied together with checkId).",
      }),
    ),
    evidence: Type.Optional(
      Type.String({
        description:
          "What you checked to confirm this - a tool result, a file's actual contents, an error message. Not a restatement of the condition. Omit when checkId is set.",
      }),
    ),
    checkId: Type.Optional(
      Type.Unsafe<DeterministicCheckId>({
        type: "string",
        enum: DETERMINISTIC_CHECK_IDS as unknown as string[],
        description:
          'If set, this condition is verified automatically by running a fixed, built-in check instead of trusting your self-report - omit met/evidence when using this. Available: "git_diff_nonempty" (true if the workspace has uncommitted changes per `git diff --quiet`).',
      }),
    ),
  },
  { additionalProperties: false },
);

const VerifyTaskToolSchema = Type.Object({
  taskType: Type.String({
    description:
      'Short label for the kind of task being verified (e.g. "file_edit", "api_call", "research_answer"). Used to group repeated verification attempts for the same task.',
  }),
  conditions: Type.Array(VerifyConditionSchema, {
    minItems: 1,
    description: "Every condition this task needs to count as complete.",
  }),
});

type VerifyCondition = {
  description: string;
  met: boolean;
  evidence?: string;
  checkId?: DeterministicCheckId;
};

type RawVerifyCondition = {
  description: string;
  met?: boolean;
  evidence?: string;
  checkId?: DeterministicCheckId;
};

function readConditions(params: Record<string, unknown>): RawVerifyCondition[] {
  const raw = params.conditions;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("conditions required");
  }
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`conditions[${index}] must be an object`);
    }
    const conditionParams = entry as Record<string, unknown>;
    const description = readStringParam(conditionParams, "description", {
      required: true,
      label: `conditions[${index}].description`,
    });
    const rawCheckId = conditionParams.checkId;
    if (rawCheckId !== undefined && !isDeterministicCheckId(rawCheckId)) {
      throw new Error(
        `conditions[${index}].checkId must be one of: ${DETERMINISTIC_CHECK_IDS.join(", ")}`,
      );
    }
    const checkId = rawCheckId;
    const evidence = readStringParam(conditionParams, "evidence");

    if (checkId) {
      if (conditionParams.met !== undefined || evidence !== undefined) {
        throw new Error(
          `conditions[${index}] must not include met/evidence together with checkId - the tool computes them.`,
        );
      }
      return { description, checkId };
    }

    const met = conditionParams.met;
    if (typeof met !== "boolean") {
      throw new Error(`conditions[${index}].met must be a boolean when checkId is not set`);
    }
    const condition: RawVerifyCondition = { description, met };
    if (evidence) {
      condition.evidence = evidence;
    }
    return condition;
  });
}

async function resolveConditions(
  raw: RawVerifyCondition[],
  opts: { workspaceDir?: string },
): Promise<VerifyCondition[]> {
  return Promise.all(
    raw.map(async (condition) => {
      if (!condition.checkId) {
        return condition as VerifyCondition;
      }
      if (!opts.workspaceDir) {
        throw new Error(
          `conditions with checkId "${condition.checkId}" require a known workspace directory, but none was available for this run.`,
        );
      }
      const { met, evidence } = await DETERMINISTIC_CHECKS[condition.checkId](opts.workspaceDir);
      return { description: condition.description, met, evidence, checkId: condition.checkId };
    }),
  );
}

/**
 * Tracks only the most recent failing signature per session, not a full
 * history - this answers "did the exact same conditions fail twice in a
 * row", not "how many times has this ever failed". Bounded by session count.
 */
const REPEAT_FAILURE_THRESHOLD = 2;
const MAX_TRACKED_SESSIONS = 2000;
const lastFailureBySession = new Map<string, { signature: string; count: number }>();

function buildFailureSignature(taskType: string, unmet: VerifyCondition[]): string {
  return digestStable({
    taskType,
    unmet: unmet.map((condition) => condition.description).toSorted(),
  });
}

function recordFailureAndGetStreak(sessionKey: string, signature: string): number {
  const prior = lastFailureBySession.get(sessionKey);
  const count = prior && prior.signature === signature ? prior.count + 1 : 1;
  lastFailureBySession.set(sessionKey, { signature, count });
  if (lastFailureBySession.size > MAX_TRACKED_SESSIONS) {
    const oldestKey = lastFailureBySession.keys().next().value;
    if (oldestKey !== undefined) {
      lastFailureBySession.delete(oldestKey);
    }
  }
  return count;
}

export function resetVerifyTaskTrackingForTest(): void {
  lastFailureBySession.clear();
}

export function createVerifyTaskTool(opts?: {
  agentSessionKey?: string;
  logger?: { error: (message: string) => void };
  workspaceDir?: string;
}): AnyAgentTool {
  return {
    label: "Verify Task",
    name: "verify_task",
    displaySummary: "Check whether a task's completion conditions are actually true.",
    description: [
      "Before declaring a task done, list its concrete completion conditions and report whether each one is actually true - not whether you expect it to be.",
      "Only mark a condition met if you checked it against a tool result, a file's real contents, or another concrete signal, and cite that in its evidence field.",
      "For a condition a fixed command can check directly (see checkId), set checkId instead of met/evidence - the tool runs the check itself instead of trusting your report.",
      "If any condition comes back unmet, fix the specific thing that failed and call this again with the same conditions restated.",
      "If the exact same conditions are still unmet on a second call in a row, this is auto-escalated to the operator - tell the user plainly that you could not complete the task and why, instead of presenting an unverified result as done.",
    ].join(" "),
    parameters: VerifyTaskToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const taskType = readStringParam(params, "taskType", { required: true });
      const rawConditions = readConditions(params);
      const conditions = await resolveConditions(rawConditions, {
        workspaceDir: opts?.workspaceDir,
      });
      const unmet = conditions.filter((condition) => !condition.met);

      if (unmet.length === 0) {
        return {
          content: [],
          details: { status: "verified" as const, taskType, conditions },
        };
      }

      const sessionKey = opts?.agentSessionKey ?? "unknown";
      const signature = buildFailureSignature(taskType, unmet);
      const repeatCount = recordFailureAndGetStreak(sessionKey, signature);

      let escalation: EscalationRecord | undefined;
      if (repeatCount >= REPEAT_FAILURE_THRESHOLD) {
        escalation = buildEscalationRecord({
          reason: `Task type "${taskType}" failed verification ${repeatCount} times in a row with the same unmet condition(s): ${unmet.map((condition) => condition.description).join("; ")}`,
          attempted:
            "Ran verify_task, attempted a fix, ran verify_task again with the same conditions still unmet.",
        });
        opts?.logger?.error(
          `agent-escalation: auto-escalated to operator: ${JSON.stringify(escalation)}`,
        );
      }

      return {
        content: [],
        details: {
          status: "unmet" as const,
          taskType,
          conditions,
          repeatCount,
          ...(escalation ? { escalation } : {}),
        },
      };
    },
  };
}
