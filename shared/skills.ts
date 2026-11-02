export type SkillSource = "hob" | "lore" | "common";
export type SkillImportSource = "pi" | "claude" | "codex";

export interface SkillView {
  id: string;
  name: string;
  description: string;
  source: SkillSource;
  content: string;
  enabled: boolean;
  overridden: boolean;
}

export interface SkillsView {
  skills: SkillView[];
  loreActive: boolean;
  loreUrl: string | null;
}

export interface ImportSkill {
  id: string;
  name: string;
  description: string;
  exists: boolean;
}

export interface SkillImportView {
  found: boolean;
  skills: ImportSkill[];
  skipped: string[];
}

export interface SkillImportResult {
  imported: string[];
  skipped: string[];
  errors: string[];
}
