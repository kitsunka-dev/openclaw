import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import type { EventLogEntry } from "../app-events.ts";
import { formatRelativeTimestamp } from "../format.ts";
import { icons } from "../icons.ts";
import type { AttentionItem } from "../types.ts";

export type OverviewTodayProps = {
  connected: boolean;
  lastError: string | null;
  attentionItems: AttentionItem[];
  eventLog: EventLogEntry[];
  sessionsCount: number | null;
  presenceCount: number;
  cronNext: number | null;
};

function statusDot(state: "ok" | "warn" | "err") {
  return html`<span class="ov-today-dot ${state}"></span>`;
}

function pickRecent(eventLog: EventLogEntry[], limit = 3): EventLogEntry[] {
  return [...eventLog].toSorted((a, b) => b.ts - a.ts).slice(0, limit);
}

function summarizeEvent(entry: EventLogEntry): string {
  const ev = entry.event;
  const payload = entry.payload as Record<string, unknown> | undefined;
  if (ev === "agent" && payload && typeof payload === "object") {
    const phase = typeof payload.phase === "string" ? payload.phase : null;
    return phase ? `${ev} · ${phase}` : ev;
  }
  if (ev.startsWith("chat.") || ev.startsWith("sessions.")) {
    const sid = payload && typeof payload.sessionId === "string" ? payload.sessionId : null;
    return sid ? `${ev} · ${sid.slice(0, 8)}` : ev;
  }
  return ev;
}

export function renderOverviewToday(props: OverviewTodayProps) {
  const errorAttention = props.attentionItems.filter((i) => i.severity === "error");
  const warnAttention = props.attentionItems.filter((i) => i.severity === "warning");
  const recent = pickRecent(props.eventLog);

  const healthState: "ok" | "warn" | "err" = !props.connected
    ? "err"
    : errorAttention.length > 0
      ? "err"
      : warnAttention.length > 0
        ? "warn"
        : "ok";

  const healthLabel = !props.connected
    ? t("overview.today.health.disconnected")
    : errorAttention.length > 0
      ? t("overview.today.health.errors")
      : warnAttention.length > 0
        ? t("overview.today.health.warnings")
        : t("overview.today.health.allClear");

  const cronNextLabel =
    props.cronNext != null ? formatRelativeTimestamp(props.cronNext) : t("common.na");

  return html`
    <section class="card ov-today">
      <div class="card-title">
        <span class="ov-today-icon">${icons.barChart}</span>
        ${t("overview.today.title")}
      </div>

      <div class="ov-today-grid">
        <div class="ov-today-block">
          <div class="ov-today-label">${t("overview.today.health.label")}</div>
          <div class="ov-today-row">
            ${statusDot(healthState)}
            <span class="ov-today-text">${healthLabel}</span>
          </div>
          ${props.lastError
            ? html`<div class="muted ov-today-sub">
                ${t("overview.today.health.lastError")}:
                <span class="mono">${props.lastError}</span>
              </div>`
            : nothing}
        </div>

        <div class="ov-today-block">
          <div class="ov-today-label">${t("overview.today.attention.label")}</div>
          <div class="ov-today-row">
            ${errorAttention.length > 0
              ? html`${statusDot("err")}
                  <span class="ov-today-text"
                    >${t("overview.today.attention.errorCount", {
                      count: String(errorAttention.length),
                    })}</span
                  >`
              : warnAttention.length > 0
                ? html`${statusDot("warn")}
                    <span class="ov-today-text"
                      >${t("overview.today.attention.warningCount", {
                        count: String(warnAttention.length),
                      })}</span
                    >`
                : html`${statusDot("ok")}
                    <span class="ov-today-text">${t("overview.today.attention.allClear")}</span>`}
          </div>
          ${errorAttention[0]
            ? html`<div class="muted ov-today-sub">${errorAttention[0].title}</div>`
            : nothing}
        </div>

        <div class="ov-today-block">
          <div class="ov-today-label">${t("overview.today.activity.label")}</div>
          ${recent.length === 0
            ? html`<div class="muted ov-today-sub">${t("overview.today.activity.empty")}</div>`
            : html`<ul class="ov-today-list">
                ${recent.map(
                  (entry) => html`<li>
                    <span class="muted">${formatRelativeTimestamp(entry.ts)}</span>
                    <span class="mono">${summarizeEvent(entry)}</span>
                  </li>`,
                )}
              </ul>`}
        </div>

        <div class="ov-today-block">
          <div class="ov-today-label">${t("overview.today.quick.label")}</div>
          <ul class="ov-today-list">
            <li>
              <span class="muted">${t("overview.today.quick.sessions")}</span>
              <span class="mono">${props.sessionsCount ?? "—"}</span>
            </li>
            <li>
              <span class="muted">${t("overview.today.quick.presence")}</span>
              <span class="mono">${props.presenceCount}</span>
            </li>
            <li>
              <span class="muted">${t("overview.today.quick.cronNext")}</span>
              <span class="mono">${cronNextLabel}</span>
            </li>
          </ul>
        </div>
      </div>
    </section>
  `;
}
