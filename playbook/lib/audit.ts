import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { findDefaultRoot, withoutExempt } from "./patch";

/**
 * Places upstream's installer chain is known to write outside its config root
 * (launchd jobs, data home, Helm, shell rc files, the default profile). The
 * converter switches each off; this snapshot proves it stayed off.
 */
export function watchedPaths(home: string): string[] {
  const h = (p: string) => join(home, p);
  return [
    h("Library/LaunchAgents"),
    h("Library/Application Support/LifeOS"),
    h("Library/Logs/lifeos"),
    h(".config/LIFEOS"),
    h(".config/systemd/user"),
    h(".config/herdr/config.toml"),
    h(".config/kitty"),
    h(".local/bin/helm"),
    h("Applications/Helm.app"),
    h(".hammerspoon/init.lua"),
    h(".hammerspoon/lifeos.lua"),
    h(".zshrc"),
    h(".bashrc"),
    h(".bash_profile"),
    h(".profile"),
    h(".gitconfig"),
    // The default profile is live (other sessions write it), so only LifeOS-owned entries.
    h(".claude/LIFEOS"),
    h(".claude/skills/LifeOS"),
  ];
}

type Entry = { exists: false } | { exists: true; kind: string; mtime: number; size: number; names?: string[] };

function entry(p: string): Entry {
  let st;
  try {
    st = lstatSync(p);
  } catch {
    return { exists: false };
  }
  const kind = st.isSymbolicLink() ? "link" : st.isDirectory() ? "dir" : "file";
  const e: Entry = { exists: true, kind, mtime: st.mtimeMs, size: st.size };
  if (kind === "dir") {
    let names = readdirSync(p).sort();
    // LaunchAgents and systemd hold other software's jobs: only LifeOS-named entries count.
    if (/LaunchAgents$|systemd\/user$/.test(p)) names = names.filter((n) => /lifeos|pai\./i.test(n));
    e.names = names;
  }
  return e;
}

export type Snapshot = Record<string, Entry>;

export function snapshot(home: string): Snapshot {
  const s: Snapshot = {};
  for (const p of watchedPaths(home)) s[p] = entry(p);
  return s;
}

/** Differences between two snapshots, one line each. Empty means nothing outside the root moved. */
export function diffSnapshots(before: Snapshot, after: Snapshot): string[] {
  const out: string[] = [];
  for (const p of Object.keys(after)) {
    const a = before[p];
    const b = after[p];
    if (!a || a.exists !== b.exists) {
      out.push(`${p}: ${a?.exists ? "removed" : "created"}`);
      continue;
    }
    if (!a.exists || !b.exists) continue;
    if (a.kind !== b.kind) out.push(`${p}: ${a.kind} -> ${b.kind}`);
    else if (a.kind === "dir") {
      const added = (b.names ?? []).filter((n) => !(a.names ?? []).includes(n));
      const removed = (a.names ?? []).filter((n) => !(b.names ?? []).includes(n));
      if (added.length) out.push(`${p}: added ${added.join(", ")}`);
      if (removed.length) out.push(`${p}: removed ${removed.join(", ")}`);
    } else if (a.mtime !== b.mtime || a.size !== b.size) out.push(`${p}: modified`);
  }
  return out;
}

function under(path: string, root: string): boolean {
  const lexical = (p: string, r: string) => p === r || p.startsWith(r.replace(/\/+$/, "") + "/");
  if (lexical(path, root)) return true;
  // Another spelling of the same directory (a symlinked parent, /var vs /private/var on macOS).
  const realRoot = existsSync(root) ? realpathSync(root) : root;
  if (lexical(path, realRoot)) return true;
  return existsSync(path) && lexical(realpathSync(path), realRoot);
}

/** Two spellings of one existing path count as equal. */
function samePath(a: unknown, b: string): boolean {
  if (a === b) return true;
  return typeof a === "string" && existsSync(a) && existsSync(b) && realpathSync(a) === realpathSync(b);
}

/**
 * Where a write to `p` lands: the parent's real path, then every symlink at the end followed,
 * dangling ones included (existsSync and realpathSync both miss a dangling link, and a write
 * creates its target).
 */
export function writeTarget(p: string): string {
  let cur = resolve(p);
  for (let i = 0; i < 40; i++) {
    let dir: string;
    try {
      dir = realpathSync(dirname(cur));
    } catch {
      return cur;
    }
    const at = join(dir, basename(cur));
    let link = false;
    try {
      link = lstatSync(at).isSymbolicLink();
    } catch {
      return at;
    }
    if (!link) return at;
    cur = resolve(dir, readlinkSync(at));
  }
  throw new Error(`${p}: too many levels of symbolic links`);
}

/** Commands registered under one settings.json hook event. */
function hookCommands(settings: Record<string, any>, event: string): string[] {
  return ((settings.hooks?.[event] ?? []) as any[]).flatMap((g) => ((g?.hooks ?? []) as any[]).map((h) => String(h?.command ?? ""))).filter(Boolean);
}

/** LifeOS without hooks runs un-bannered and never rebuilds settings: both are required. */
export function hookProblems(settings: Record<string, any>): string[] {
  const all = Object.keys(settings.hooks ?? {}).flatMap((e) => hookCommands(settings, e));
  if (!all.length) return ["settings.json registers no hooks"];
  if (!hookCommands(settings, "SessionStart").some((c) => /MergeSettings/.test(c))) return ["settings.json: SessionStart does not run the settings rebuild (MergeSettings)"];
  return [];
}

/** Problems inside the root after conversion: leftover default-root paths, links that escape. */
export function auditInside(root: string, home: string, userData: string): string[] {
  const problems: string[] = [];
  for (const f of ["settings.json", "settings.system.json"]) {
    const p = join(root, f);
    if (!existsSync(p)) continue;
    const doc = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    const left = findDefaultRoot(JSON.stringify(withoutExempt(doc)), home);
    if (left.length) problems.push(`${f}: ${left.length} path(s) still point at the default profile (${[...new Set(left)].join(", ")})`);
    // cpb's exclusion must keep naming ~/.claude; an entry inside the root hides LifeOS's own CLAUDE.md files.
    const excludes = Array.isArray(doc.claudeMdExcludes) ? (doc.claudeMdExcludes as unknown[]).map(String) : [];
    for (const e of excludes) if (under(e.replace(/\/\*\*$/, ""), root)) problems.push(`${f}: claudeMdExcludes entry ${e} hides the playbook's own CLAUDE.md`);
  }
  const settings = JSON.parse(readFileSync(join(root, "settings.json"), "utf8")) as Record<string, any>;
  if (!samePath(settings.env?.LIFEOS_CONFIG_DIR, userData)) problems.push(`settings.json: env.LIFEOS_CONFIG_DIR is ${settings.env?.LIFEOS_CONFIG_DIR}, expected ${userData}`);
  if (!samePath(settings.env?.LIFEOS_DIR, join(root, "LIFEOS"))) problems.push(`settings.json: env.LIFEOS_DIR is ${settings.env?.LIFEOS_DIR}, expected ${join(root, "LIFEOS")}`);
  const configPath = join(userData, "USER", "CONFIG", "LIFEOS_CONFIG.toml");
  if (!samePath(settings.env?.LIFEOS_CONFIG_PATH, configPath) && settings.env?.LIFEOS_CONFIG_PATH !== configPath) problems.push(`settings.json: env.LIFEOS_CONFIG_PATH is ${settings.env?.LIFEOS_CONFIG_PATH}, expected ${configPath} (else LifeOS reads ~/.claude's config)`);
  else if (!existsSync(configPath)) problems.push(`${configPath}: missing (LIFEOS_CONFIG_PATH points at it)`);
  for (const [event, groups] of Object.entries((settings.hooks ?? {}) as Record<string, any[]>)) {
    for (const g of groups ?? []) {
      for (const h of g?.hooks ?? []) {
        const cmd = String(h?.command ?? "");
        for (const m of cmd.match(/(?:\/[\w.@-]+)+\.(?:ts|sh|js)\b/g) ?? []) {
          if (!under(m, root)) problems.push(`settings.json hooks.${event}: ${m} is outside the root`);
        }
      }
    }
  }
  problems.push(...hookProblems(settings));
  // LinkUser's contract: LIFEOS/USER is the data home's USER, and LIFEOS/MEMORY is USER/MEMORY there.
  for (const [link, want] of [["LIFEOS/USER", join(userData, "USER")], ["LIFEOS/MEMORY", join(userData, "USER", "MEMORY")]] as const) {
    const p = join(root, link);
    if (!existsSync(p)) {
      problems.push(`${link}: missing`);
      continue;
    }
    const real = realpathSync(p);
    if (!under(real, realpathSync(root))) problems.push(`${link}: resolves outside the root (${real})`);
    else if (!existsSync(want) || real !== realpathSync(want)) problems.push(`${link}: resolves to ${real}, expected ${want}`);
  }
  return problems;
}
