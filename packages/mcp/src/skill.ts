/** What the skill text is rendered for (11 §6.2). */
export interface SkillContext {
  /** The instance's base URL, e.g. `https://rooster.example.com`. */
  instanceUrl: string;
  /** The rooster version the skill is versioned with. */
  version: string;
}

/**
 * The full `SKILL.md` (front matter `name: rooster` plus the body, ≤ 300 lines; 11 §6.2).
 * Served at `/.well-known/agent-skills/rooster/SKILL.md` (with its sha256 in the index),
 * printed by `rooster skill print` and installed by `rooster skill install`.
 */
export function skillMarkdown(_context: SkillContext): string {
  throw new Error('P9 WP 9.2: not implemented');
}

/** The short form sent as the MCP `instructions` on `initialize` (11 §5.2). */
export function skillInstructions(_context: SkillContext): string {
  throw new Error('P9 WP 9.2: not implemented');
}
