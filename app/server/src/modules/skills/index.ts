/**
 * Per-domain skills: durable notes (selectors, role/name pairs, flow
 * sequences) an agent already worked out for a site, saved to
 * skills/<name>/SKILL.md so a future session skips rediscovery. Format
 * mirrors Claude Code's own SKILL.md convention.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SKILLS_DIR } from "../../configs/paths.js";
import { errorMessage } from "../../libs/errorMessage.js";
import { MAX_SKILL_CONTENT_CHARS, SKILL_NAME_PATTERN } from "./constants.js";
import type { SkillMeta } from "./types.js";

export type { SkillMeta } from "./types.js";

try {
  mkdirSync(SKILLS_DIR, { recursive: true });
} catch {}

/** Parses the self-produced frontmatter block (only saveSkill ever writes it) — a small regex is enough, no need for a real YAML dependency this narrow. */
function parseSkillFrontmatter(content: string): { name?: string; domains: string[]; description?: string } {
  const fm = content.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  const domainsBlock = fm.match(/^domains:\s*\n((?:\s*-\s*.+\n?)+)/m)?.[1] ?? "";
  const domains = domainsBlock
    .split("\n")
    .map((l) => l.trim().replace(/^-\s*/, ""))
    .filter(Boolean);
  return {
    name: fm.match(/^name:\s*(.+)$/m)?.[1]?.trim(),
    description: fm.match(/^description:\s*(.+)$/m)?.[1]?.trim(),
    domains,
  };
}

/** Metadata only (never full content) for saved skills, optionally filtered by exact domain or a name/description/domains substring. */
export function listSkills(filter?: { domain?: string; query?: string }): SkillMeta[] {
  let dirs: string[];
  try {
    dirs = readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
  const skills: SkillMeta[] = [];
  for (const dir of dirs) {
    const path = join(SKILLS_DIR, dir, "SKILL.md");
    try {
      const meta = parseSkillFrontmatter(readFileSync(path, "utf8"));
      skills.push({ name: meta.name ?? dir, domains: meta.domains, description: meta.description, path });
    } catch {
      // A manually-broken skill dir shouldn't crash listing every other one.
    }
  }
  if (filter?.domain) {
    const domain = filter.domain.toLowerCase();
    return skills.filter((s) => s.domains.some((d) => d.toLowerCase() === domain));
  }
  if (filter?.query) {
    const q = filter.query.toLowerCase();
    return skills.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description?.toLowerCase().includes(q) ||
        s.domains.some((d) => d.toLowerCase().includes(q)),
    );
  }
  return skills;
}

/** First saved skill whose domains include this exact hostname. */
export function findSkillForHostname(hostname: string): SkillMeta | undefined {
  return listSkills().find((s) => s.domains.includes(hostname));
}

function findOverlappingSkill(name: string, domains: string[]): SkillMeta | undefined {
  return listSkills().find((s) => s.name !== name && s.domains.some((d) => domains.includes(d)));
}

function buildSkillFile(name: string, domains: string[], description: string | undefined, content: string): string {
  const domainsYaml = domains.map((d) => `  - ${d}`).join("\n");
  const frontmatter = [
    "---",
    `name: ${name}`,
    "domains:",
    domainsYaml,
    ...(description ? [`description: ${description}`] : []),
    "---",
    "",
  ].join("\n");
  return frontmatter + content;
}

/**
 * Create or overwrite a skill. Domains are required for a new skill, and
 * inherited from the existing file when updating one that already has them
 * (so a content-only update doesn't wipe metadata the caller didn't touch).
 * Returns a `_duplicateWarning` when a genuinely new skill's domains
 * overlap an existing one — see browser_knowledge's save_skill action.
 */
export function saveSkill(args: {
  name?: unknown;
  domains?: unknown;
  description?: unknown;
  content?: unknown;
}): Record<string, unknown> {
  const name = typeof args.name === "string" ? args.name : "";
  if (!SKILL_NAME_PATTERN.test(name)) {
    return {
      error: `Invalid skill name: "${name}"`,
      hint: 'Use a lowercase slug (letters, numbers, hyphens, underscores only), e.g. "github" or "mio-fe-admin-inquiries".',
    };
  }
  const content = typeof args.content === "string" ? args.content : "";
  if (content.length > MAX_SKILL_CONTENT_CHARS) {
    return {
      error: `Skill content too long (${content.length} chars, max ${MAX_SKILL_CONTENT_CHARS})`,
      hint: "Trim to the essentials — selectors, role/name pairs, flow sequences, gotchas. This isn't meant to hold full page dumps.",
    };
  }

  const path = join(SKILLS_DIR, name, "SKILL.md");
  let domains: string[] | undefined = Array.isArray(args.domains)
    ? args.domains.filter((d): d is string => typeof d === "string")
    : undefined;
  let description = typeof args.description === "string" ? args.description : undefined;

  const existing = existsSync(path) ? parseSkillFrontmatter(readFileSync(path, "utf8")) : undefined;
  if (!domains || domains.length === 0) {
    if (!existing) {
      return {
        error: "Missing domains",
        hint: 'New skills need at least one domain (e.g. ["github.com"]) so browser_session\'s navigate action can find them. Omit only when updating a skill that already has domains set.',
      };
    }
    domains = existing.domains;
  }
  if (description === undefined) {
    description = existing?.description;
  }

  const isNewSkill = !existsSync(path);
  const overlap = isNewSkill ? findOverlappingSkill(name, domains) : undefined;

  try {
    mkdirSync(join(SKILLS_DIR, name), { recursive: true });
    writeFileSync(path, buildSkillFile(name, domains, description, content));
  } catch (e) {
    return { error: `Failed to write skill: ${errorMessage(e)}` };
  }
  return {
    success: true,
    message: `Saved skill "${name}"`,
    path,
    domains,
    ...(overlap
      ? {
          _duplicateWarning: `Skill "${overlap.name}" (${overlap.path}) already covers ${overlap.domains.filter((d) => domains!.includes(d)).join(", ")}. Consider merging into that one (browser_knowledge({action:"save_skill", name:"${overlap.name}"})) instead of keeping both — two skills for the same site drift out of sync and cost double the context on every list_skills call.`,
        }
      : {}),
  };
}
