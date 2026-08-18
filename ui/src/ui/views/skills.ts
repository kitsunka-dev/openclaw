import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import type { SkillMessageMap } from "../controllers/skills.ts";
import { clampText } from "../format.ts";
import { resolveSafeExternalUrl } from "../open-external-url.ts";
import type { SkillStatusEntry, SkillStatusReport } from "../types.ts";
import { groupSkills, inferSkillCategory, inferSkillLane } from "./skills-grouping.ts";
import {
  computeSkillMissing,
  computeSkillReasons,
  renderSkillStatusChips,
} from "./skills-shared.ts";

function safeExternalHref(raw?: string): string | null {
  if (!raw) {
    return null;
  }
  return resolveSafeExternalUrl(raw, window.location.href);
}

export type SkillsStatusFilter = "all" | "ready" | "needs-setup" | "disabled";

export type SkillsProps = {
  connected: boolean;
  loading: boolean;
  report: SkillStatusReport | null;
  error: string | null;
  filter: string;
  statusFilter: SkillsStatusFilter;
  edits: Record<string, string>;
  busyKey: string | null;
  messages: SkillMessageMap;
  detailKey: string | null;
  onFilterChange: (next: string) => void;
  onStatusFilterChange: (next: SkillsStatusFilter) => void;
  onRefresh: () => void;
  onToggle: (skillKey: string, enabled: boolean) => void;
  onEdit: (skillKey: string, value: string) => void;
  onSaveKey: (skillKey: string) => void;
  onInstall: (skillKey: string, name: string, installId: string) => void;
  onDetailOpen: (skillKey: string) => void;
  onDetailClose: () => void;
};

type StatusTabDef = { id: SkillsStatusFilter; label: string };

const STATUS_TABS: StatusTabDef[] = [
  { id: "all", label: "All" },
  { id: "ready", label: "Ready" },
  { id: "needs-setup", label: "Needs Setup" },
  { id: "disabled", label: "Disabled" },
];


function renderSkillSearchText(skill: SkillStatusEntry): string {
  const missing = computeSkillMissing(skill).join(" ");
  return [
    skill.name,
    skill.description,
    skill.source,
    skill.filePath,
    inferSkillCategory(skill),
    inferSkillLane(skill),
    missing,
  ]
    .join(" ")
    .toLowerCase();
}

function renderSourceKind(skill: SkillStatusEntry): string {
  const filePath = skill.filePath.toLowerCase();
  if (filePath.includes("/workspace/mizi-") || filePath.includes("/mizi-")) {
    return "mizi";
  }
  if (filePath.includes("/workspace/skills/")) {
    return "workspace";
  }
  if (filePath.includes("/extensions/")) {
    return "extension";
  }
  if (skill.bundled || skill.source === "openclaw-bundled") {
    return "built-in";
  }
  if (skill.source === "openclaw-managed") {
    return "managed";
  }
  return skill.source || "unknown";
}

function renderSkillStatusLabel(skill: SkillStatusEntry): string {
  if (skill.disabled) {
    return "disabled";
  }
  if (skill.blockedByAllowlist) {
    return "blocked by allowlist";
  }
  if (!skill.filePath || !skill.description) {
    return "broken metadata";
  }
  if (skill.eligible) {
    return "ready";
  }
  return "missing requirements";
}

function skillMatchesStatus(skill: SkillStatusEntry, status: SkillsStatusFilter): boolean {
  switch (status) {
    case "all":
      return true;
    case "ready":
      return !skill.disabled && skill.eligible;
    case "needs-setup":
      return !skill.disabled && !skill.eligible;
    case "disabled":
      return skill.disabled;
  }
}

function skillStatusClass(skill: SkillStatusEntry): string {
  if (skill.disabled) {
    return "muted";
  }
  return skill.eligible ? "ok" : "warn";
}

export function renderSkills(props: SkillsProps) {
  const skills = props.report?.skills ?? [];

  const statusCounts: Record<SkillsStatusFilter, number> = {
    all: skills.length,
    ready: 0,
    "needs-setup": 0,
    disabled: 0,
  };
  let brokenCount = 0;
  for (const s of skills) {
    if (!s.filePath || !s.description) {
      brokenCount++;
    }
    if (s.disabled) {
      statusCounts.disabled++;
    } else if (s.eligible) {
      statusCounts.ready++;
    } else {
      statusCounts["needs-setup"]++;
    }
  }

  const afterStatus =
    props.statusFilter === "all"
      ? skills
      : skills.filter((s) => skillMatchesStatus(s, props.statusFilter));

  const filter = props.filter.trim().toLowerCase();
  const filtered = filter
    ? afterStatus.filter((skill) => renderSkillSearchText(skill).includes(filter))
    : afterStatus;
  const groups = groupSkills(filtered);

  const detailSkill = props.detailKey
    ? (skills.find((s) => s.skillKey === props.detailKey) ?? null)
    : null;

  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Skills Catalog</div>
          <div class="card-sub">Live OpenClaw skills from real VPS roots — no mock-only data.</div>
        </div>
        <button
          class="btn"
          ?disabled=${props.loading || !props.connected}
          @click=${props.onRefresh}
        >
          ${props.loading ? "Loading\u2026" : "Refresh"}
        </button>
      </div>

      <div class="callout" style="margin-top: 14px;">
        <div style="font-weight: 700; margin-bottom: 4px;">Owner Mode truth model</div>
        <div>Shows the engine's live skill status plus filesystem roots checked by the gateway. Trust is raw source/SKILL.md/operator judgement; no fake cryptographic safety or platform fantasy.</div>
      </div>

      <div class="usage-summary-grid" style="margin-top: 14px;">
        <div class="usage-summary-card"><div class="usage-summary-label">Ready</div><div class="usage-summary-value">${statusCounts.ready}</div></div>
        <div class="usage-summary-card"><div class="usage-summary-label">Needs setup</div><div class="usage-summary-value">${statusCounts["needs-setup"]}</div></div>
        <div class="usage-summary-card"><div class="usage-summary-label">Disabled</div><div class="usage-summary-value">${statusCounts.disabled}</div></div>
        <div class="usage-summary-card"><div class="usage-summary-label">Broken</div><div class="usage-summary-value">${brokenCount}</div></div>
      </div>

      ${props.report?.roots?.length
        ? html`<div class="agent-skills-groups" style="margin-top: 14px;">
            <details class="agent-skills-group" open>
              <summary class="agent-skills-header">
                <span>Checked skill roots</span>
                <span class="muted">${props.report.roots.length}</span>
              </summary>
              <div class="list">
                ${props.report.roots.map(
                  (root) => html`<div class="list-item">
                    <div class="list-main">
                      <div class="list-title" style="font-family: var(--mono); font-size: 12px;">${root.path}</div>
                      <div class="list-sub">exists=${String(root.exists)} · readable=${String(root.readable)} · skillDirs=${root.skillDirs}${root.error ? ` · ${root.error}` : ""}</div>
                    </div>
                  </div>`,
                )}
              </div>
            </details>
          </div>`
        : nothing}

      ${props.report?.errors?.length
        ? html`<div class="callout danger" style="margin-top: 12px;">
            <div style="font-weight: 700; margin-bottom: 4px;">Data source warnings</div>
            ${props.report.errors.map((error) => html`<div>${error}</div>`)}
          </div>`
        : nothing}

      <div class="agent-tabs" style="margin-top: 14px;">
        ${STATUS_TABS.map(
          (tab) => html`
            <button
              class="agent-tab ${props.statusFilter === tab.id ? "active" : ""}"
              @click=${() => props.onStatusFilterChange(tab.id)}
            >
              ${tab.label}<span class="agent-tab-count">${statusCounts[tab.id]}</span>
            </button>
          `,
        )}
      </div>

      <div
        class="filters"
        style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 12px;"
      >
        <a
          class="btn btn--sm"
          href="https://clawhub.com"
          target="_blank"
          rel="noreferrer"
          title="Browse skills on ClawHub"
          >Browse Skills Store</a
        >
        <label class="field" style="flex: 1; min-width: 180px;">
          <input
            .value=${props.filter}
            @input=${(e: Event) => props.onFilterChange((e.target as HTMLInputElement).value)}
            placeholder="Search skills"
            autocomplete="off"
            name="skills-filter"
          />
        </label>
        <div class="muted">${filtered.length} shown</div>
      </div>

      ${props.error
        ? html`<div class="callout danger" style="margin-top: 12px;">${props.error}</div>`
        : nothing}
      ${filtered.length === 0
        ? html`
            <div class="muted" style="margin-top: 16px">
              ${!props.connected && !props.report
                ? "Not connected to gateway. Checked roots and gateway errors will appear after connection."
                : "No skills found. Data source status is shown above so this page does not fail blank."}
            </div>
          `
        : html`
            <div class="agent-skills-groups" style="margin-top: 16px;">
              ${groups.map((group) => {
                return html`
                  <details class="agent-skills-group" open>
                    <summary class="agent-skills-header">
                      <span>${group.label}</span>
                      <span class="muted">${group.skills.length}</span>
                    </summary>
                    <div class="list skills-grid">
                      ${group.skills.map((skill) => renderSkill(skill, props))}
                    </div>
                  </details>
                `;
              })}
            </div>
          `}
    </section>

    ${detailSkill ? renderSkillDetail(detailSkill, props) : nothing}
  `;
}

function renderSkill(skill: SkillStatusEntry, props: SkillsProps) {
  const busy = props.busyKey === skill.skillKey;
  const dotClass = skillStatusClass(skill);

  return html`
    <div class="list-item list-item-clickable" @click=${() => props.onDetailOpen(skill.skillKey)}>
      <div class="list-main">
        <div class="list-title" style="display: flex; align-items: center; gap: 8px;">
          <span class="statusDot ${dotClass}"></span>
          ${skill.emoji ? html`<span>${skill.emoji}</span>` : nothing}
          <span>${skill.name}</span>
        </div>
        <div class="list-sub">${clampText(skill.description, 140)}</div>
        <div class="list-sub" style="margin-top: 4px;">${renderSkillStatusLabel(skill)} · ${renderSourceKind(skill)} · ${inferSkillCategory(skill)} · lane: ${inferSkillLane(skill)}</div>
        <div class="list-sub" style="margin-top: 4px; font-family: var(--mono);">${skill.filePath}</div>
      </div>
      <div
        class="list-meta"
        style="display: flex; align-items: center; justify-content: flex-end; gap: 10px;"
      >
        <label class="skill-toggle-wrap" @click=${(e: Event) => e.stopPropagation()}>
          <input
            type="checkbox"
            class="skill-toggle"
            .checked=${!skill.disabled}
            ?disabled=${busy}
            @change=${(e: Event) => {
              e.stopPropagation();
              props.onToggle(skill.skillKey, skill.disabled);
            }}
          />
        </label>
      </div>
    </div>
  `;
}

function renderSkillDetail(skill: SkillStatusEntry, props: SkillsProps) {
  const busy = props.busyKey === skill.skillKey;
  const apiKey = props.edits[skill.skillKey] ?? "";
  const message = props.messages[skill.skillKey] ?? null;
  const canInstall = skill.install.length > 0 && skill.missing.bins.length > 0;
  const showBundledBadge = Boolean(skill.bundled && skill.source !== "openclaw-bundled");
  const missing = computeSkillMissing(skill);
  const reasons = computeSkillReasons(skill);
  const ensureModalOpen = (el?: Element) => {
    if (!(el instanceof HTMLDialogElement) || el.open) {
      return;
    }
    el.showModal();
  };

  return html`
    <dialog
      class="md-preview-dialog"
      ${ref(ensureModalOpen)}
      @click=${(e: Event) => {
        const dialog = e.currentTarget as HTMLDialogElement;
        if (e.target === dialog) {
          dialog.close();
        }
      }}
      @close=${props.onDetailClose}
    >
      <div class="md-preview-dialog__panel">
        <div class="md-preview-dialog__header">
          <div
            class="md-preview-dialog__title"
            style="display: flex; align-items: center; gap: 8px;"
          >
            <span class="statusDot ${skillStatusClass(skill)}"></span>
            ${skill.emoji ? html`<span style="font-size: 18px;">${skill.emoji}</span>` : nothing}
            <span>${skill.name}</span>
          </div>
          <button
            class="btn btn--sm"
            @click=${(e: Event) => {
              (e.currentTarget as HTMLElement).closest("dialog")?.close();
            }}
          >
            Close
          </button>
        </div>
        <div class="md-preview-dialog__body" style="display: grid; gap: 16px;">
          <div>
            <div style="font-size: 14px; line-height: 1.5; color: var(--text);">
              ${skill.description}
            </div>
            <div class="muted" style="margin-top: 8px; font-size: 13px;">Status: ${renderSkillStatusLabel(skill)} · source: ${renderSourceKind(skill)} · category: ${inferSkillCategory(skill)} · best-fit lane: ${inferSkillLane(skill)}</div>
            ${renderSkillStatusChips({ skill, showBundledBadge })}
          </div>

          ${missing.length > 0
            ? html`
                <div
                  class="callout"
                  style="border-color: var(--warn-subtle); background: var(--warn-subtle); color: var(--warn);"
                >
                  <div style="font-weight: 600; margin-bottom: 4px;">Missing requirements</div>
                  <div>${missing.join(", ")}</div>
                </div>
              `
            : nothing}
          ${reasons.length > 0
            ? html`
                <div class="muted" style="font-size: 13px;">Reason: ${reasons.join(", ")}</div>
              `
            : nothing}

          <div style="display: flex; align-items: center; gap: 12px;">
            <label class="skill-toggle-wrap">
              <input
                type="checkbox"
                class="skill-toggle"
                .checked=${!skill.disabled}
                ?disabled=${busy}
                @change=${() => props.onToggle(skill.skillKey, skill.disabled)}
              />
            </label>
            <span style="font-size: 13px; font-weight: 500;">
              ${skill.disabled ? "Disabled" : "Enabled"}
            </span>
            ${canInstall
              ? html`<button
                  class="btn"
                  ?disabled=${busy}
                  @click=${() => props.onInstall(skill.skillKey, skill.name, skill.install[0].id)}
                >
                  ${busy ? "Installing\u2026" : skill.install[0].label}
                </button>`
              : nothing}
          </div>

          ${message
            ? html`<div class="callout ${message.kind === "error" ? "danger" : "success"}">
                ${message.message}
              </div>`
            : nothing}
          ${skill.primaryEnv
            ? html`
                <div style="display: grid; gap: 8px;">
                  <div class="field">
                    <span
                      >API key
                      <span class="muted" style="font-weight: normal; font-size: 0.88em;"
                        >(${skill.primaryEnv})</span
                      ></span
                    >
                    <input
                      type="password"
                      .value=${apiKey}
                      @input=${(e: Event) =>
                        props.onEdit(skill.skillKey, (e.target as HTMLInputElement).value)}
                    />
                  </div>
                  ${(() => {
                    const href = safeExternalHref(skill.homepage);
                    return href
                      ? html`<div class="muted" style="font-size: 13px;">
                          Get your key:
                          <a href="${href}" target="_blank" rel="noopener noreferrer"
                            >${skill.homepage}</a
                          >
                        </div>`
                      : nothing;
                  })()}
                  <button
                    class="btn primary"
                    ?disabled=${busy}
                    @click=${() => props.onSaveKey(skill.skillKey)}
                  >
                    Save key
                  </button>
                </div>
              `
            : nothing}

          <div
            style="border-top: 1px solid var(--border); padding-top: 12px; display: grid; gap: 6px; font-size: 12px; color: var(--muted);"
          >
            <div><span style="font-weight: 600;">Source:</span> ${skill.source}</div>
            <div style="font-family: var(--mono); word-break: break-all;">${skill.filePath}</div>
            ${(() => {
              const safeHref = safeExternalHref(skill.homepage);
              return safeHref
                ? html`<div>
                    <a href="${safeHref}" target="_blank" rel="noopener noreferrer"
                      >${skill.homepage}</a
                    >
                  </div>`
                : nothing;
            })()}
          </div>
        </div>
      </div>
    </dialog>
  `;
}
