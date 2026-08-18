import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { evaluateEntryRequirementsForCurrentPlatform } from "../shared/entry-status.js";
import type { RequirementConfigCheck, Requirements } from "../shared/requirements.js";
import { CONFIG_DIR } from "../utils.js";
import {
  hasBinary,
  isBundledSkillAllowed,
  isConfigPathTruthy,
  loadWorkspaceSkillEntries,
  resolveBundledAllowlist,
  resolveSkillConfig,
  resolveSkillsInstallPreferences,
  type SkillEntry,
  type SkillEligibilityContext,
  type SkillInstallSpec,
  type SkillsInstallPreferences,
} from "./skills.js";
import { resolveBundledSkillsContext } from "./skills/bundled-context.js";
import { resolveSkillSource } from "./skills/source.js";

export type SkillStatusConfigCheck = RequirementConfigCheck;

export type SkillInstallOption = {
  id: string;
  kind: SkillInstallSpec["kind"];
  label: string;
  bins: string[];
};

export type SkillStatusEntry = {
  name: string;
  description: string;
  source: string;
  bundled: boolean;
  filePath: string;
  baseDir: string;
  skillKey: string;
  primaryEnv?: string;
  emoji?: string;
  homepage?: string;
  always: boolean;
  disabled: boolean;
  blockedByAllowlist: boolean;
  eligible: boolean;
  requirements: Requirements;
  missing: Requirements;
  configChecks: SkillStatusConfigCheck[];
  install: SkillInstallOption[];
};

export type SkillRootStatus = {
  path: string;
  exists: boolean;
  readable: boolean;
  skillDirs: number;
  error?: string;
};

export type SkillStatusReport = {
  workspaceDir: string;
  managedSkillsDir: string;
  skills: SkillStatusEntry[];
  roots: SkillRootStatus[];
  errors: string[];
  checkedAt: string;
};


function scanSkillRootStatus(rootPath: string): SkillRootStatus {
  try {
    const entries = fs.readdirSync(rootPath, { withFileTypes: true });
    const skillDirs = entries.filter(
      (entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules",
    ).length;
    return { path: rootPath, exists: true, readable: true, skillDirs };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      path: rootPath,
      exists: !message.includes("ENOENT"),
      readable: false,
      skillDirs: 0,
      error: message,
    };
  }
}

function uniqueRoots(roots: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const root of roots) {
    if (!root) {
      continue;
    }
    const normalized = path.resolve(root);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function resolveExistingWorkspaceSkillRoots(workspaceDir: string): string[] {
  const candidates = [
    path.join(workspaceDir, "skills"),
    path.join(workspaceDir, "mizi-skills"),
    path.join(workspaceDir, "mizi-ai-skills"),
    path.join(workspaceDir, "mizi-agents", "skills"),
    path.join(workspaceDir, ".agents", "skills"),
  ];
  return candidates.filter((candidate) => {
    try {
      return fs.statSync(candidate).isDirectory();
    } catch {
      return false;
    }
  });
}

function resolveExistingExtensionSkillRoots(openclawRoot: string): string[] {
  const extensionsDir = path.join(openclawRoot, "extensions");
  try {
    return fs
      .readdirSync(extensionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => path.join(extensionsDir, entry.name, "skills"))
      .filter((candidate) => {
        try {
          return fs.statSync(candidate).isDirectory();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

function resolveStatusRoots(params: {
  workspaceDir: string;
  managedSkillsDir: string;
  bundledSkillsDir?: string;
  skillEntries: SkillEntry[];
}): string[] {
  void params.skillEntries;
  const openclawRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
  return uniqueRoots([
    ...resolveExistingWorkspaceSkillRoots(params.workspaceDir),
    params.managedSkillsDir,
    params.bundledSkillsDir,
    ...resolveExistingExtensionSkillRoots(openclawRoot),
    ...(process.env.OPENCLAW_EXTRA_SKILL_ROOTS ?? "").split(path.delimiter),
  ]);
}

function resolveSkillKey(entry: SkillEntry): string {
  return entry.metadata?.skillKey ?? entry.skill.name;
}

function selectPreferredInstallSpec(
  install: SkillInstallSpec[],
  prefs: SkillsInstallPreferences,
): { spec: SkillInstallSpec; index: number } | undefined {
  if (install.length === 0) {
    return undefined;
  }

  const indexed = install.map((spec, index) => ({ spec, index }));
  const findKind = (kind: SkillInstallSpec["kind"]) =>
    indexed.find((item) => item.spec.kind === kind);

  const brewSpec = findKind("brew");
  const nodeSpec = findKind("node");
  const goSpec = findKind("go");
  const uvSpec = findKind("uv");
  const downloadSpec = findKind("download");
  const brewAvailable = hasBinary("brew");

  // Table-driven preference chain; first match wins.
  const pickers: Array<() => { spec: SkillInstallSpec; index: number } | undefined> = [
    () => (prefs.preferBrew && brewAvailable ? brewSpec : undefined),
    () => uvSpec,
    () => nodeSpec,
    // Only prefer brew when available to avoid guaranteed failure on Linux/Docker.
    () => (brewAvailable ? brewSpec : undefined),
    () => goSpec,
    // Prefer download over an unavailable brew spec.
    () => downloadSpec,
    // Last resort: surface descriptive brew-missing error instead of "no installer found".
    () => brewSpec,
    () => indexed[0],
  ];

  for (const pick of pickers) {
    const selected = pick();
    if (selected) {
      return selected;
    }
  }

  return undefined;
}

function normalizeInstallOptions(
  entry: SkillEntry,
  prefs: SkillsInstallPreferences,
): SkillInstallOption[] {
  // If the skill is explicitly OS-scoped, don't surface install actions on unsupported platforms.
  // (Installers run locally; remote OS eligibility is handled separately.)
  const requiredOs = entry.metadata?.os ?? [];
  if (requiredOs.length > 0 && !requiredOs.includes(process.platform)) {
    return [];
  }

  const install = entry.metadata?.install ?? [];
  if (install.length === 0) {
    return [];
  }

  const platform = process.platform;
  const filtered = install.filter((spec) => {
    const osList = spec.os ?? [];
    return osList.length === 0 || osList.includes(platform);
  });
  if (filtered.length === 0) {
    return [];
  }

  const toOption = (spec: SkillInstallSpec, index: number): SkillInstallOption => {
    const id = (spec.id ?? `${spec.kind}-${index}`).trim();
    const bins = spec.bins ?? [];
    let label = (spec.label ?? "").trim();
    if (spec.kind === "node" && spec.package) {
      label = `Install ${spec.package} (${prefs.nodeManager})`;
    }
    if (!label) {
      if (spec.kind === "brew" && spec.formula) {
        label = `Install ${spec.formula} (brew)`;
      } else if (spec.kind === "node" && spec.package) {
        label = `Install ${spec.package} (${prefs.nodeManager})`;
      } else if (spec.kind === "go" && spec.module) {
        label = `Install ${spec.module} (go)`;
      } else if (spec.kind === "uv" && spec.package) {
        label = `Install ${spec.package} (uv)`;
      } else if (spec.kind === "download" && spec.url) {
        const url = spec.url.trim();
        const last = url.split("/").pop();
        label = `Download ${last && last.length > 0 ? last : url}`;
      } else {
        label = "Run installer";
      }
    }
    return { id, kind: spec.kind, label, bins };
  };

  const allDownloads = filtered.every((spec) => spec.kind === "download");
  if (allDownloads) {
    return filtered.map((spec, index) => toOption(spec, index));
  }

  const preferred = selectPreferredInstallSpec(filtered, prefs);
  if (!preferred) {
    return [];
  }
  return [toOption(preferred.spec, preferred.index)];
}

function buildSkillStatus(
  entry: SkillEntry,
  config?: OpenClawConfig,
  prefs?: SkillsInstallPreferences,
  eligibility?: SkillEligibilityContext,
  bundledNames?: Set<string>,
): SkillStatusEntry {
  const skillKey = resolveSkillKey(entry);
  const skillConfig = resolveSkillConfig(config, skillKey);
  const disabled = skillConfig?.enabled === false;
  const allowBundled = resolveBundledAllowlist(config);
  const blockedByAllowlist = !isBundledSkillAllowed(entry, allowBundled);
  const always = entry.metadata?.always === true;
  const isEnvSatisfied = (envName: string) =>
    Boolean(
      process.env[envName] ||
      skillConfig?.env?.[envName] ||
      (skillConfig?.apiKey && entry.metadata?.primaryEnv === envName),
    );
  const isConfigSatisfied = (pathStr: string) => isConfigPathTruthy(config, pathStr);
  const skillSource = resolveSkillSource(entry.skill);
  const bundled =
    skillSource === "openclaw-bundled" ||
    (skillSource === "unknown" && bundledNames?.has(entry.skill.name) === true);

  const { emoji, homepage, required, missing, requirementsSatisfied, configChecks } =
    evaluateEntryRequirementsForCurrentPlatform({
      always,
      entry,
      hasLocalBin: hasBinary,
      remote: eligibility?.remote,
      isEnvSatisfied,
      isConfigSatisfied,
    });
  const eligible = !disabled && !blockedByAllowlist && requirementsSatisfied;

  return {
    name: entry.skill.name,
    description: entry.skill.description,
    source: skillSource,
    bundled,
    filePath: entry.skill.filePath,
    baseDir: entry.skill.baseDir,
    skillKey,
    primaryEnv: entry.metadata?.primaryEnv,
    emoji,
    homepage,
    always,
    disabled,
    blockedByAllowlist,
    eligible,
    requirements: required,
    missing,
    configChecks,
    install: normalizeInstallOptions(entry, prefs ?? resolveSkillsInstallPreferences(config)),
  };
}

export function buildWorkspaceSkillStatus(
  workspaceDir: string,
  opts?: {
    config?: OpenClawConfig;
    managedSkillsDir?: string;
    entries?: SkillEntry[];
    eligibility?: SkillEligibilityContext;
  },
): SkillStatusReport {
  const managedSkillsDir = opts?.managedSkillsDir ?? path.join(CONFIG_DIR, "skills");
  const bundledContext = resolveBundledSkillsContext();
  const skillEntries =
    opts?.entries ??
    loadWorkspaceSkillEntries(workspaceDir, {
      config: opts?.config,
      managedSkillsDir,
      bundledSkillsDir: bundledContext.dir,
    });
  const prefs = resolveSkillsInstallPreferences(opts?.config);
  const roots = resolveStatusRoots({
    workspaceDir,
    managedSkillsDir,
    bundledSkillsDir: bundledContext.dir,
    skillEntries,
  }).map(scanSkillRootStatus);
  const errors = roots
    .filter((root) => root.exists && !root.readable)
    .map((root) => `${root.path}: ${root.error ?? "unreadable"}`);
  return {
    workspaceDir,
    managedSkillsDir,
    skills: skillEntries.map((entry) =>
      buildSkillStatus(entry, opts?.config, prefs, opts?.eligibility, bundledContext.names),
    ),
    roots,
    errors,
    checkedAt: new Date().toISOString(),
  };
}
