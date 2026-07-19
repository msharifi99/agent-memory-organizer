export const SECTION_TITLES = {
  summary: "Summary",
  current_decisions: "Current Decisions",
  preferences_and_guidance: "Preferences And Guidance",
  tasks: "Tasks",
  open_questions: "Open Questions",
  explorations: "Explorations",
  timeline: "Timeline",
  sources: "Sources",
} as const;

export type SectionKey = keyof typeof SECTION_TITLES;
export type Sections = Record<SectionKey, string[]>;

export function emptySections(): Sections {
  return Object.fromEntries(
    Object.keys(SECTION_TITLES).map((key) => [key, []]),
  ) as unknown as Sections;
}

export function normalizeItems(value: unknown): string[] {
  if (value == null) return [];
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (!Array.isArray(value)) return [];

  const items: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.trim()) {
      items.push(item.trim());
    } else if (item && typeof item === "object") {
      const raw = item as Record<string, unknown>;
      const text = raw.text ?? raw.summary ?? raw.content;
      if (typeof text === "string" && text.trim()) {
        items.push(text.trim());
      }
    }
  }
  return items;
}

export function renderMemory(title: string, sections: Sections): string {
  const lines = [`# ${title.trim() || "Untitled Memory"}`, ""];
  for (const [key, heading] of Object.entries(SECTION_TITLES) as [SectionKey, string][]) {
    lines.push(`## ${heading}`);
    const items = sections[key] ?? [];
    if (items.length > 0) {
      for (const item of items) lines.push(`- ${item}`);
    } else {
      lines.push("- None recorded.");
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function parseMemory(markdown: string): { title: string; sections: Sections } {
  const sections = emptySections();
  const headingToKey = new Map<string, SectionKey>(
    Object.entries(SECTION_TITLES).map(([key, heading]) => [
      heading,
      key as SectionKey,
    ]),
  );
  let title = "Untitled Memory";
  let currentKey: SectionKey | undefined;

  for (const line of markdown.split(/\r?\n/)) {
    if (line.startsWith("# ") && title === "Untitled Memory") {
      title = line.slice(2).trim() || title;
      continue;
    }
    if (line.startsWith("## ")) {
      currentKey = headingToKey.get(line.slice(3).trim());
      continue;
    }
    if (currentKey && line.startsWith("- ")) {
      const item = line.slice(2).trim();
      if (item && item !== "None recorded.") sections[currentKey].push(item);
    }
  }
  return { title, sections };
}

export function mergeSectionItems(existing: string[], additions: string[]): string[] {
  const merged = [...existing];
  const seen = new Set(merged.map((item) => item.toLowerCase()));
  for (const item of additions) {
    if (!seen.has(item.toLowerCase())) {
      merged.push(item);
      seen.add(item.toLowerCase());
    }
  }
  return merged;
}
