import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { findDefaultRoot } from "./patch";

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
  return path === root || path.startsWith(root.replace(/\/+$/, "") + "/");
}

/** Problems inside the root after conversion: leftover default-root paths, links that escape. */
export function auditInside(root: string, home: string, userData: string): string[] {
  const problems: string[] = [];
  for (const f of ["settings.json", "settings.system.json"]) {
    const p = join(root, f);
    if (!existsSync(p)) continue;
    const left = findDefaultRoot(readFileSync(p, "utf8"), home);
    if (left.length) problems.push(`${f}: ${left.length} path(s) still point at the default profile (${[...new Set(left)].join(", ")})`);
  }
  const settings = JSON.parse(readFileSync(join(root, "settings.json"), "utf8")) as Record<string, any>;
  if (settings.env?.LIFEOS_CONFIG_DIR !== userData) problems.push(`settings.json: env.LIFEOS_CONFIG_DIR is ${settings.env?.LIFEOS_CONFIG_DIR}, expected ${userData}`);
  if (settings.env?.LIFEOS_DIR !== join(root, "LIFEOS")) problems.push(`settings.json: env.LIFEOS_DIR is ${settings.env?.LIFEOS_DIR}, expected ${join(root, "LIFEOS")}`);
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
  for (const link of ["LIFEOS/USER", "LIFEOS/MEMORY"]) {
    const p = join(root, link);
    if (!existsSync(p)) {
      problems.push(`${link}: missing`);
      continue;
    }
    const real = realpathSync(p);
    if (!under(real, realpathSync(root))) problems.push(`${link}: resolves outside the root (${real})`);
  }
  return problems;
}
