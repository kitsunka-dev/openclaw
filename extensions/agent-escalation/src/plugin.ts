import type {
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { createEscalateToOperatorTool } from "./escalate-to-operator-tool.js";
import { createVerifyTaskTool } from "./verify-task-tool.js";

export function registerAgentEscalationPlugin(api: OpenClawPluginApi): void {
  api.registerTool(createEscalateToOperatorTool(), { name: "escalate_to_operator" });

  api.registerTool(
    (ctx: OpenClawPluginToolContext) =>
      createVerifyTaskTool({
        agentSessionKey: ctx.sessionKey,
        logger: api.logger,
        workspaceDir: ctx.workspaceDir,
      }),
    { name: "verify_task" },
  );
}
