import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerAgentEscalationPlugin } from "./src/plugin.js";

export default definePluginEntry({
  id: "agent-escalation",
  name: "Agent Escalation",
  description:
    "Gives agents an explicit escalate_to_operator tool and a verify_task tool that auto-escalates repeated verification failures, instead of guessing.",
  register: registerAgentEscalationPlugin,
});
