import type { SkillStatusEntry } from "../types.ts";

export type SkillCategory =
  | "Core/System"
  | "Coding/Engineering"
  | "UI/Frontend"
  | "MIZI CRM"
  | "Marketing/Growth"
  | "Media/Creative"
  | "Integrations/APIs"
  | "Infra/Ops"
  | "Uncategorized";

export type SkillLane = "main" | "executor" | "reviewer" | "shared" | "unknown";

export type SkillGroup = {
  id: string;
  label: SkillCategory;
  skills: SkillStatusEntry[];
};

export const SKILL_CATEGORY_ORDER: SkillCategory[] = [
  "Core/System",
  "Coding/Engineering",
  "UI/Frontend",
  "MIZI CRM",
  "Marketing/Growth",
  "Media/Creative",
  "Integrations/APIs",
  "Infra/Ops",
  "Uncategorized",
];

function skillText(skill: SkillStatusEntry): string {
  return `${skill.name} ${skill.description} ${skill.source} ${skill.filePath}`.toLowerCase();
}

export function inferSkillCategory(skill: SkillStatusEntry): SkillCategory {
  const text = skillText(skill);
  if (
    text.includes("mizi") ||
    text.includes("salesdrive") ||
    text.includes("finmap") ||
    text.includes("monobank") ||
    text.includes("nova poshta")
  ) {
    return "MIZI CRM";
  }
  if (/(nextjs|react|tailwind|shadcn|ui|frontend|html-to-image|drawio)/.test(text)) {
    return "UI/Frontend";
  }
  if (/(typescript|python|prisma|postgres|fastapi|pytorch|coding|github|docker|vercel|code|sql|database)/.test(text)) {
    return "Coding/Engineering";
  }
  if (/(marketing|ads|seo|copywriting|tiktok|creative performance|growth|e-commerce|ecommerce)/.test(text)) {
    return "Marketing/Growth";
  }
  if (/(video|image|tts|whisper|audio|pdf|creative|avatar|background|media|banana|nsfw)/.test(text)) {
    return "Media/Creative";
  }
  if (/(api|integration|jira|linear|sentry|google sheet|notion|slack|discord|telegram|whatsapp|oauth|github)/.test(text)) {
    return "Integrations/APIs";
  }
  if (/(health|gateway|node|tmux|deploy|infra|ops|subscription|auth|updater|security|skill-vetter|clawhub)/.test(text)) {
    return "Infra/Ops";
  }
  if (/(memory|session|summarize|agent|skill|clawflow|ontology|proactive|router)/.test(text)) {
    return "Core/System";
  }
  return "Uncategorized";
}

export function inferSkillLane(skill: SkillStatusEntry): SkillLane {
  const text = skillText(skill);
  const category = inferSkillCategory(skill);
  if (/(review|audit|vet|analy[sz]e|diagnose|health|sentry|security)/.test(text)) {
    return "reviewer";
  }
  if (/(generate|create|edit|deploy|execute|run|send|transcribe|render|remove|query|manage|install|update)/.test(text)) {
    return "executor";
  }
  if (category === "Core/System" || /(orchestration|routing|memory|session|proactive|ontology|system)/.test(text)) {
    return "main";
  }
  if (category === "Uncategorized") {
    return "unknown";
  }
  return "shared";
}

export function groupSkills(skills: SkillStatusEntry[]): SkillGroup[] {
  const groups = new Map<SkillCategory, SkillStatusEntry[]>();
  for (const category of SKILL_CATEGORY_ORDER) {
    groups.set(category, []);
  }
  for (const skill of skills) {
    groups.get(inferSkillCategory(skill))?.push(skill);
  }
  return SKILL_CATEGORY_ORDER.map((category) => ({
    id: category.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    label: category,
    skills: groups.get(category) ?? [],
  })).filter((group) => group.skills.length > 0);
}
