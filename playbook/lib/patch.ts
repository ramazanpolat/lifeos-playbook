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
 * `/`, a quote, whitespace, `)`, `,`, `:`, `;` or end of string. `.claude-playbooks`,
 * `.claude.json` and `.claudeX` never match.
 */
export function defaultRootPattern(home: string): RegExp {
  const prefixes = ["\\$\\{HOME\\}", "\\$HOME", "~", escapeRe(home.replace(/\/+$/, ""))];
  return new RegExp(`(?:${prefixes.join("|")})/\\.claude(?=[/"'\\s),:;]|$)`, "g");
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
    "- Background services (Pulse, launchd jobs), the Helm terminal layer and the shell alias are not installed: they write outside the config root.",
    SECTION_END,
  ].join("\n");
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
