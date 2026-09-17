import { Type } from "@sinclair/typebox";
import { readStringParam } from "openclaw/plugin-sdk/param-readers";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";

const EscalateToOperatorToolSchema = Type.Object({
  reason: Type.String({
    description:
      "Why you cannot complete this confidently without guessing - missing data, an ambiguous request, a failed lookup, or something outside your authority.",
  }),
  attempted: Type.Optional(
    Type.String({
      description: "What you already tried before deciding to escalate, if anything.",
    }),
  ),
  question: Type.Optional(
    Type.String({
      description: "The specific question or decision you need the operator to resolve.",
    }),
  ),
});

export type EscalationRecord = {
  status: "escalated";
  reason: string;
  attempted?: string;
  question?: string;
};

/**
 * Shared shape-builder so a model-initiated escalate_to_operator call and any
 * future code-detected auto-escalation in this plugin produce the exact same
 * record shape.
 */
export function buildEscalationRecord(params: {
  reason: string;
  attempted?: string;
  question?: string;
}): EscalationRecord {
  return {
    status: "escalated",
    reason: params.reason,
    ...(params.attempted ? { attempted: params.attempted } : {}),
    ...(params.question ? { question: params.question } : {}),
  };
}

export function createEscalateToOperatorTool(): AnyAgentTool {
  return {
    label: "Escalate to Operator",
    name: "escalate_to_operator",
    displaySummary: "Flag that you cannot answer confidently and need a human.",
    description: [
      "Use this when you do not have enough information or confidence to complete the request correctly, and guessing risks giving a wrong answer.",
      "Call this instead of fabricating a result. State the reason, what you already tried, and, if relevant, the specific question the operator needs to resolve.",
      "After calling this tool, tell the user plainly that you are escalating and why - never present a guess as if it were a verified answer.",
    ].join(" "),
    parameters: EscalateToOperatorToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const reason = readStringParam(params, "reason", { required: true });
      const attempted = readStringParam(params, "attempted");
      const question = readStringParam(params, "question");
      return {
        content: [],
        details: buildEscalationRecord({ reason, attempted, question }),
      };
    },
  };
}
