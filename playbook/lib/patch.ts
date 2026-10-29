// Pure transforms the converter applies around upstream's installer. No I/O here,
// so every rule is unit-testable without running a line of upstream code.

export const BOOTSTRAP_MARKER = "<!-- lifeos-playbook:bootstrap -->";
export const SECTION_BEGIN = "<!-- lifeos-playbook:begin -->";
export const SECTION_END = "<!-- lifeos-playbook:end -->";

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Every spelling upstream uses for the default config root, boundary-anchored:
 * `~/.claude`, `$HOME/.claude`, `${HOME}/.claude` and `<home>/.claude`, followed by
 * `/`, a quote or backtick, whitespace, a closing bracket, `>`, `,`, `:`, `;`, a
 * sentence-final `.`, or end of string, and not preceded by a path character.
 * `.claude-playbooks`, `.claude.json`, `.claudeX` and `/backup/<home>/.claude` never match.
 */
export function defaultRootPattern(home: string): RegExp {
  const prefixes = ["\\$\\{HOME\\}", "\\$HOME", "~", escapeRe(home.replace(/\/+$/, ""))];
  // Left boundary: a home path inside another path (/backup/home/user/.claude) is not the default root.
  return new RegExp(`(?<![\\w./~$])(?:${prefixes.join("|")})/\\.claude(?=[/"'\`\\s)\\]}>,:;]|\\.(?!\\w)|$)`, "g");
}

/** Rewrite every default-root spelling to the playbook root. */
export function rebaseDefaultRoot(text: string, home: string, root: string): { text: string; count: number } {
  let count = 0;
  const out = text.replace(defaultRootPattern(home), () => {
    count++;
    return root;
  });
  return { text: out, count };
}

/** Default-root spellings still present (for the audit). */
export function findDefaultRoot(text: string, home: string): string[] {
  return text.match(defaultRootPattern(home)) ?? [];
}

/** Force env keys in a settings object. Returns the keys whose value changed. */
export function forceEnv(settings: Record<string, unknown>, env: Record<string, string>): string[] {
  const cur = (settings.env && typeof settings.env === "object" ? settings.env : (settings.env = {})) as Record<string, unknown>;
  const changed: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (cur[k] !== v) {
      cur[k] = v;
      changed.push(k);
    }
  }
  return changed;
}

export function isBootstrap(claudeMd: string): boolean {
  return claudeMd.includes(BOOTSTRAP_MARKER);
}

/** The playbook section appended to upstream's CLAUDE.md. */
export function playbookSection(o: { root: string; userData: string; version: string; commit: string }): string {
  return [
    SECTION_BEGIN,
    "## LifeOS playbook",
    "",
    `This LifeOS install is an isolated Claude Code playbook. Its config root is \`${o.root}\`, not \`~/.claude\`.`,
    "",
    `- Personal data (USER tree, memory) lives in \`${o.userData}\`; \`LIFEOS/USER\` links there.`,
    `- Upstream release: ${o.version} (commit ${o.commit.slice(0, 12)}), converted by \`playbook/convert.ts\`.`,
    "- Update with `cpb update <playbook-name>`; it re-runs the converter on the newly pinned release.",
    "- Never write to `~/.claude`: it is a different Claude Code profile.",
    "- Background services (Pulse, launchd and systemd jobs), the statusline refresher job, the Helm terminal layer and the shell alias are not installed: they write outside the config root. Do not install them during setup or later; tell the user why if they ask.",
    "- Personal instructions go in `CLAUDE.local.md` beside this file: updates replace CLAUDE.md with upstream's template, never CLAUDE.local.md.",
    "",
    "@CLAUDE.local.md",
    SECTION_END,
  ].join("\n");
}

/** The document without the playbook section (to compare what upstream wrote). */
export function stripSection(claudeMd: string): string {
  const b = claudeMd.indexOf(SECTION_BEGIN);
  const e = claudeMd.indexOf(SECTION_END);
  if (b < 0 || e < b) return claudeMd.replace(/\s*$/, "");
  return (claudeMd.slice(0, b) + claudeMd.slice(e + SECTION_END.length)).replace(/\s*$/, "");
}

/** Insert or replace the playbook section; idempotent. */
export function upsertSection(claudeMd: string, section: string): string {
  const b = claudeMd.indexOf(SECTION_BEGIN);
  const e = claudeMd.indexOf(SECTION_END);
  if (b >= 0 && e > b) {
    return claudeMd.slice(0, b) + section + claudeMd.slice(e + SECTION_END.length);
  }
  return claudeMd.replace(/\s*$/, "") + "\n\n" + section + "\n";
}

/** Labels of core services (optIn:false) from `Services.ts list --json` output. */
export function coreServices(listJson: string): string[] {
  const rows = JSON.parse(listJson) as Array<{ label?: unknown; optIn?: unknown }>;
  if (!Array.isArray(rows)) throw new Error("Services.ts list --json did not return an array");
  return rows
    .filter((r) => r && r.optIn === false && typeof r.label === "string")
    .map((r) => (r.label as string).replace(/^com\.lifeos\./, ""))
    .sort();
}

/** Components to deploy: the wanted set intersected with what the release offers. */
export function pickComponents(wanted: readonly string[], offered: readonly string[]): { use: string[]; missing: string[] } {
  const use = wanted.filter((c) => offered.includes(c));
  const missing = wanted.filter((c) => !offered.includes(c));
  return { use, missing };
}

/**
 * Copy `keys` from the live settings into the user layer when their value differs from the
 * system layer's (the user layer wins the merge, key by key). A value equal to the system
 * default is left out so a later default change still reaches the install. Returns the keys copied.
 */
export function preserveKeys(live: Record<string, unknown>, system: Record<string, unknown>, layer: Record<string, unknown>, keys: readonly string[]): string[] {
  const copied: string[] = [];
  for (const k of keys) {
    if (!(k in live)) continue;
    if (k in system && JSON.stringify(system[k]) === JSON.stringify(live[k])) continue;
    if (JSON.stringify(layer[k]) === JSON.stringify(live[k])) continue;
    layer[k] = live[k];
    copied.push(k);
  }
  return copied;
}

/**
 * Settings keys whose paths name the default profile on purpose. cpb's claudeMdExcludes
 * holds `<home>/.claude/**` to keep ~/.claude's CLAUDE.md out of the playbook; rebasing it
 * would exclude the playbook's own CLAUDE.md files instead.
 */
export const REBASE_EXEMPT_KEYS = ["claudeMdExcludes"] as const;

/** A copy of a settings object without the exempt keys (for rebasing and auditing). */
export function withoutExempt(settings: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...settings };
  for (const k of REBASE_EXEMPT_KEYS) delete copy[k];
  return copy;
}

/** Rebase a settings document, leaving the exempt keys exactly as they were. */
export function rebaseSettings(settings: Record<string, unknown>, home: string, root: string): { settings: Record<string, unknown>; count: number } {
  const { text, count } = rebaseDefaultRoot(JSON.stringify(withoutExempt(settings)), home, root);
  const out = JSON.parse(text) as Record<string, unknown>;
  for (const k of REBASE_EXEMPT_KEYS) if (k in settings) out[k] = settings[k];
  return { settings: out, count };
}
