export type GatewayAgentIdentity = {
  name?: string;
  theme?: string;
  emoji?: string;
  avatar?: string;
  avatarUrl?: string;
};

export type GatewayAgentModel = {
  primary?: string;
  fallbacks?: string[];
};

export type GatewayOwnerModeAcpLane = {
  id: string;
  status: "working" | "forbidden";
  reason?: string;
};

export type GatewayOwnerModeSummary = {
  enabled: boolean;
  productionBrain: string;
  workspace: string;
  sessionCanon: string;
  subagents: {
    allowAny: boolean;
    allowedAgents: string[];
    maxConcurrent?: number;
    maxChildrenPerAgent?: number;
    maxSpawnDepth?: number;
    requireAgentId?: boolean;
  };
  agentToAgent: {
    enabled: boolean;
    allow: string[];
    sessionsVisibility: string;
  };
  acp: {
    backend?: string;
    defaultAgent?: string;
    allowedAgents: string[];
    lanes: GatewayOwnerModeAcpLane[];
  };
};

export type GatewayAgentRow = {
  id: string;
  name?: string;
  identity?: GatewayAgentIdentity;
  workspace?: string;
  model?: GatewayAgentModel;
};

export type SessionsListResultBase<TDefaults, TRow> = {
  ts: number;
  path: string;
  count: number;
  defaults: TDefaults;
  sessions: TRow[];
};

export type SessionsPatchResultBase<TEntry> = {
  ok: true;
  path: string;
  key: string;
  entry: TEntry;
};
