import { Type } from "@sinclair/typebox";
import {
  describeEscalateToOperatorTool,
  ESCALATE_TO_OPERATOR_TOOL_DISPLAY_SUMMARY,
} from "../tool-description-presets.js";
import { type AnyAgentTool, readStringParam } from "./common.js";

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
 * Shared shape-builder so a model-initiated escalate_to_operator call and a
 * code-detected auto-escalation (e.g. a critical tool-loop block) produce the
 * exact same record - one path doesn't have to happen for the other to count.
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
    displaySummary: ESCALATE_TO_OPERATOR_TOOL_DISPLAY_SUMMARY,
    description: describeEscalateToOperatorTool(),
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
