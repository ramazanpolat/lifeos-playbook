#!/usr/bin/env bun
/**
 * convert -- turn the pinned upstream LifeOS release into this playbook.
 *
 *   bun playbook/convert.ts            # convert (fresh install, or upgrade in place)
 *   bun playbook/convert.ts --plan     # print what would happen, change nothing
 *   bun playbook/convert.ts --check    # is the converted install healthy? (only Doctor's own status files change)
 *
 * Flags: --root <dir>        playbook root (default: the playbook this script lives in)
 *        --pin <file>        pin file (default: playbook/upstream.json)
 *        --src <dir>         local upstream checkout at the pinned commit, instead of fetching
 *        --unverified-src    accept --src without checking its commit
 *        --allow-downgrade   convert a release older than the installed one
 *        --keep-staging      keep the fetched source after a successful run
 *        --skip-settings-backport   upgrade even if carrying settings.json edits into the user layer fails
 *        --migrate-from <v> --migrate-to <v>   set by bin/migrate (cpb update), logged only
 *
 * The conversion is a policy over upstream's own installer, not a rewrite of it:
 *   1. fetch the pinned commit and prove HEAD is that commit
 *   2. pre-seed settings.json so the data home and LIFEOS dir resolve inside the root
 *   3. place the skill with the release's own install.sh (no alias edits, no launch)
 *   4. run the release's InstallAll.ts with the config root set to the playbook, every
 *      core service declined, and only components that stay inside the root
 *   5. rebase the default-profile (~/.claude) and default data-home (~/.config/LIFEOS) paths
 *      upstream leaves in settings files and the USER tree
 *   6. append the playbook section to CLAUDE.md, then run the per-session settings rebuild once
 *   7. audit: nothing inside points at ~/.claude, hooks registered, USER and MEMORY mounted on
 *      the data home, nothing outside the root changed. Every write is confined to the root.
 *
 * --check runs upstream's Doctor with this playbook's settings env (a bare Doctor run from a
 * shell lacks it and misreports the USER links), plus the pin, the audit and the USER resolution.
 *
 * Exit: 0 converted and clean (with --plan: ready; with --check: healthy), 1 failed (with --check: not converted), 2 refused (preflight; with --plan:
 *       not ready, the missing prerequisite is named), 3 converted but the audit found problems.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { auditInside, diffSnapshots, hookProblems, snapshot, writeTarget } from "./lib/audit";
import { coreServices, forceEnv, isBootstrap, pickComponents, playbookSection, preserveKeys, rebaseDefaultRoot, rebaseSettings, stripSection, upsertSection } from "./lib/patch";
import { acquireLock } from "./lib/lock";
import { bunCacheDir, bunCacheProblem } from "./lib/prereq";
import { compareVersions, fetchCommit, readPin, stamp, verifyLocalSource } from "./lib/pin";
import { run } from "./lib/sh";

/** Components that write only inside the root. statusline, helm, pulse, worksweep and derivedsync write outside it. */
const WANTED_COMPONENTS = ["tooltips", "spinnerverbs", "agents", "commands", "workflows"];
const USER_DATA = "user-data";
const STATE_DIR = ".lifeos-playbook";
const USER_LAYER = `${USER_DATA}/USER/CONFIG/settings.user.json`;
const SNAPSHOT = "LIFEOS/MEMORY/STATE/settings-merge-snapshot.json";
const SKILL_BACKUPS_KEPT = 2;
/** settings.json keys cpb writes: claudeMdExcludes keeps ~/.claude's CLAUDE.md out; model and agent from SET. */
const CPB_KEYS = ["claudeMdExcludes", "model", "agent"];
const BUN_MIN: [number, number] = [1, 2];

class Refusal extends Error {}

interface Opts {
  root: string;
  pin: string;
  src?: string;
  unverifiedSrc: boolean;
  allowDowngrade: boolean;
  keepStaging: boolean;
  skipBackport: boolean;
  plan: boolean;
  check: boolean;
  migrateFrom?: string;
  migrateTo?: string;
}

function parseArgs(argv: string[]): Opts {
  const here = import.meta.dir;
  const o: Opts = { root: dirname(here), pin: join(here, "upstream.json"), unverifiedSrc: false, allowDowngrade: false, keepStaging: false, skipBackport: false, plan: false, check: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Refusal(`${a} needs a value. Show the flags with: bun ${import.meta.path} --help`);
      return v;
    };
    if (a === "--root") o.root = val();
    else if (a === "--pin") o.pin = val();
    else if (a === "--src") o.src = resolve(val());
    else if (a === "--unverified-src") o.unverifiedSrc = true;
    else if (a === "--allow-downgrade") o.allowDowngrade = true;
    else if (a === "--keep-staging") o.keepStaging = true;
    else if (a === "--skip-settings-backport") o.skipBackport = true;
    else if (a === "--plan") o.plan = true;
    else if (a === "--check") o.check = true;
    else if (a === "--migrate-from") o.migrateFrom = val();
    else if (a === "--migrate-to") o.migrateTo = val();
    else if (a === "-h" || a === "--help") {
      console.log(readFileSync(import.meta.path, "utf8").split("*/")[0]);
      process.exit(0);
    } else throw new Refusal(`unknown argument: ${a}. Show the flags with: bun ${import.meta.path} --help`);
  }
  // One spelling of the root on every run, whatever path or symlink led here (on macOS,
  // /var/folders is a link to /private/var/folders, and import.meta.dir reports the latter).
  o.root = existsSync(o.root) ? realpathSync(resolve(o.root)) : resolve(o.root);
  return o;
}

const log = (m: string) => console.log(`[convert] ${m}`);

/** The command that reruns this conversion as the user started it (for "then run: ..." hints). */
let RETRY = `bun ${import.meta.path}`;
function retryCommand(o: Opts): string {
  const here = import.meta.dir;
  let c = `bun ${join(o.root, "playbook", "convert.ts")}`;
  if (o.root !== dirname(here)) c = `bun ${import.meta.path} --root ${o.root}`;
  if (o.pin !== join(here, "upstream.json")) c += ` --pin ${o.pin}`;
  if (o.src) c += ` --src ${o.src}`;
  if (o.unverifiedSrc) c += " --unverified-src";
  if (o.allowDowngrade) c += " --allow-downgrade";
  return c;
}

function preflight(root: string, home: string): void {
  if (!existsSync(join(root, ".playbook"))) throw new Refusal(`${root} has no .playbook, so it is not a playbook. Point --root at the directory cpb created, or create one with: cpb CREATE PLAYBOOK lifeos FROM https://github.com/ramazanpolat/lifeos-playbook`);
  if (/\s/.test(root)) throw new Refusal(`the playbook path contains whitespace (${root}), which breaks upstream's hook commands. Use a playbook directory whose path has none`);
  const def = join(home, ".claude");
  if (existsSync(def) && realpathSync(root) === realpathSync(def)) throw new Refusal("~/.claude is the default Claude Code profile, not a playbook; it is never converted. Convert the playbook instead: bun ~/.claude-playbooks/lifeos/playbook/convert.ts --plan");
  // Every path the conversion writes must stay inside the root, symlinks resolved: a
  // settings.json linked to ~/.claude/settings.json would be written through.
  const realRoot = realpathSync(root);
  const inside = (real: string) => real === realRoot || real.startsWith(realRoot + "/");
  const confined = (rels: string[]) => {
    for (const rel of rels) {
      const real = writeTarget(join(root, rel));
      if (!inside(real)) throw new Refusal(`${rel} is a link to ${real}, outside the playbook; converting would write through it. Keep a copy of that target, replace ${join(root, rel)} with a real file or directory, then check again with --plan`);
    }
  };
  // Top-level entries first: LIFEOS itself linked away would make the mount check below name a
  // path inside the other tree.
  confined(["settings.json", "settings.system.json", "CLAUDE.md", USER_DATA, STATE_DIR, "LIFEOS", "skills", "hooks", "agents", "commands", "workflows", ".git", ".gitignore", `${USER_DATA}/USER`, `${USER_DATA}/USER/CONFIG`, `${USER_DATA}/USER/MEMORY`, USER_LAYER, `${STATE_DIR}/bun-cache`]);
  // The USER and MEMORY mounts: a relink to ~/.config/LIFEOS (what a bare Doctor run suggests)
  // would send the pre-upgrade backport's writes there, before upstream's LinkUser runs.
  for (const [rel, want] of [["LIFEOS/USER", `${USER_DATA}/USER`], ["LIFEOS/MEMORY", `${USER_DATA}/USER/MEMORY`]]) {
    const p = join(root, rel);
    let link = false;
    try {
      link = lstatSync(p).isSymbolicLink();
    } catch {}
    if (!link) continue;
    const real = writeTarget(p);
    if (!inside(real))
      throw new Refusal(`${rel} points at ${real}, outside the playbook (a relink that a bare Doctor run suggests does this). Point it back at the data home: ln -sfn ${join(root, want)} ${p} , then check again with --plan`);
  }
  // What the pre-upgrade backport writes, through the mounts.
  confined([SNAPSHOT, "LIFEOS/USER/CONFIG/settings.user.json"]);
  confineTo = realRoot;
  const v = run("bun", ["--version"], { capture: true }).stdout.trim();
  const [maj, min] = v.split(".").map(Number);
  if (maj < BUN_MIN[0] || (maj === BUN_MIN[0] && min < BUN_MIN[1])) throw new Refusal(`bun ${v} is too old; LifeOS needs ${BUN_MIN.join(".")} or newer. Run: bun upgrade`);
  run("git", ["--version"], { capture: true });
}

/** Prerequisites the conversion needs but --plan only reports. */
/**
 * bun's shared package cache, when this user cannot use it (left owned by root by an earlier
 * sudo bun): the conversion then gives upstream's installer a cache inside the playbook, so it
 * needs no root to repair someone else's directory.
 */
function bunCacheFallback(home: string, stateDir: string): { shared: string; local: string; fix: string } | null {
  const shared = bunCacheDir(process.env, home);
  const problem = bunCacheProblem(shared, home);
  return problem ? { shared, local: join(stateDir, "bun-cache"), fix: problem.fix } : null;
}

function missingPrerequisites(): string[] {
  const out: string[] = [];
  // node-pty (Pulse Desktop) has no Linux prebuild: upstream's DeployCore compiles it with node-gyp.
  if (process.platform === "linux") {
    const missing = ["make", "g++"].filter((t) => run("sh", ["-c", `command -v ${t}`], { capture: true, allowFail: true }).code !== 0);
    if (missing.length) out.push(`LifeOS's installer compiles node-pty on Linux and needs ${missing.join(" and ")}: install them first (Debian/Ubuntu: sudo apt install build-essential)`);
  }
  return out;
}

/** Same rule InstallAll uses: VERSION, settings.json and a live LIFEOS/USER. */
function installedVersion(root: string): string | null {
  const vf = join(root, "LIFEOS", "VERSION");
  if (!existsSync(vf) || !existsSync(join(root, "settings.json")) || !existsSync(join(root, "LIFEOS", "USER"))) return null;
  return readFileSync(vf, "utf8").trim();
}

function documentedComponents(deployComponentsTs: string): string[] {
  const m = deployComponentsTs.match(/DOCUMENTED_OPTIONAL_COMPONENTS\s*=\s*\[([\s\S]*?)\]/);
  if (!m) throw new Error("DeployComponents.ts: DOCUMENTED_OPTIONAL_COMPONENTS not found (upstream changed its component list)");
  return [...m[1].matchAll(/"([\w-]+)"/g)].map((x) => x[1]);
}

function readJson(p: string): Record<string, any> {
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
}

/** Commands registered on SessionStart. */
function sessionStartCommands(settings: Record<string, any>): string[] {
  return ((settings.hooks?.SessionStart ?? []) as any[]).flatMap((g) => ((g?.hooks ?? []) as any[]).map((h) => String(h?.command ?? ""))).filter(Boolean);
}

/** Set once preflight has passed: every file the converter writes must land inside it. */
let confineTo: string | null = null;

function writeText(p: string, text: string): void {
  if (confineTo) {
    // Checked per write, not only in preflight: upstream's installer runs in between and the
    // USER tree is the user's own, so a link can appear anywhere below the root.
    const t = writeTarget(p);
    if (t !== confineTo && !t.startsWith(confineTo + "/")) throw new Error(`${p} leads to ${t}, outside the playbook, so it was not written. Replace that link with a real file, then run again: ${RETRY}`);
  }
  writeFileSync(p, text);
}

function mkdirConfined(dir: string): void {
  if (confineTo) {
    const t = writeTarget(dir);
    if (t !== confineTo && !t.startsWith(confineTo + "/")) throw new Error(`${dir} leads to ${t}, outside the playbook, so it was not created. Replace that link with a real directory, then run again: ${RETRY}`);
  }
  mkdirSync(dir, { recursive: true });
}

function writeJson(p: string, v: unknown): void {
  writeText(p, JSON.stringify(v, null, 2) + "\n");
}

/**
 * The env every LifeOS process in this playbook needs, pinned in settings.json, the system
 * layer and the user layer. LIFEOS_CONFIG_PATH matters most: LifeosConfig.ts defaults to
 * ~/.claude/LIFEOS/USER/CONFIG/LIFEOS_CONFIG.toml whatever CLAUDE_CONFIG_DIR says, and
 * lifeosUserDir() falls back to ~/.claude/LIFEOS/USER when that file is missing.
 */
function rootEnvFor(root: string, userData: string): Record<string, string> {
  return {
    LIFEOS_CONFIG_DIR: userData,
    LIFEOS_DIR: join(root, "LIFEOS"),
    LIFEOS_CONFIG_PATH: join(userData, "USER", "CONFIG", "LIFEOS_CONFIG.toml"),
  };
}

/** Environment for every upstream process: config root, data home and temp dir inside the root. */
// Each of these outranks or redirects the config root (TOOLS/Paths.ts, OverlaySystem, InstallHooks).
const REDIRECTING_ENV = ["CLAUDE_PLUGIN_ROOT", "LIFEOS_HARNESS", "LIFEOS_TAG", "LIFEOS_TARBALL_URL", "LIFEOS_EXPECTED_SHA256", "DRY_RUN"];

function upstreamEnv(root: string, userData: string, tmp: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of REDIRECTING_ENV) delete env[k];
  Object.assign(env, rootEnvFor(root, userData));
  env.CLAUDE_CONFIG_DIR = root;
  env.LIFEOS_SKILLS_DIR = join(root, "skills");
  env.TMPDIR = tmp;
  // Pulse Desktop is not installed; skip its 100 MB Electron download into the user cache.
  env.ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
  return env;
}

/** Exclusive lock: created atomically, released only by its owner, a dead owner's lock taken over. */
function lock(stateDir: string): () => void {
  const f = join(stateDir, "convert.lock");
  const got = acquireLock(f);
  if ("release" in got) {
    if (got.tookOverFrom) log(`an earlier conversion (pid ${got.tookOverFrom}) was interrupted; took over its lock and continuing`);
    return got.release;
  }
  if (got.busy)
    throw new Refusal(`another conversion holds the lock (pid ${got.busy}). Wait for it to finish, then run the command again. To see what pid ${got.busy} is: ps -p ${got.busy} -o pid=,command= . Only if it is not a conversion, remove ${f}`);
  const busy = "another conversion started at the same moment and holds the lock. Wait for it to finish, then run the command again";
  throw new Refusal(got.takeover ? `${busy}. If no conversion is running, remove ${got.takeover} and ${f}, then run again: ${RETRY}` : busy);
}

interface InstallStep {
  name: string;
  status: string;
  exit?: number;
  reason?: string;
  tail?: string;
  report?: unknown;
}

/** Run InstallAll in JSON mode: one line per step, and the reason and output of a failed one. */
function installAll(args: string[], root: string, env: Record<string, string | undefined>): void {
  const r = run("bun", args, { cwd: root, env, capture: true, allowFail: true });
  let report: { ok?: boolean; mode?: string; error?: string; steps?: InstallStep[] } | null = null;
  try {
    report = JSON.parse(r.stdout);
  } catch {}
  if (!report || typeof report !== "object" || !Array.isArray(report.steps)) {
    const tail = (r.stderr || r.stdout).trim().split("\n").slice(-20).join("\n");
    throw new Error(`upstream's installer stopped without a usable report (exit ${r.code}; interrupted?). The conversion is safe to run again: ${RETRY}${tail ? `\nits last output:\n${tail}` : ""}`);
  }
  log(`InstallAll (${report.mode ?? "?"}): ${(report.steps ?? []).map((s) => `${s.name} ${s.status}`).join(", ")}`);
  const failed = (report.steps ?? []).filter((s) => s.status === "failed");
  if (failed.length) {
    const timedOut = failed.some((s) => s.exit === 124 || /timed out/.test(s.reason ?? ""));
    log(`installation incomplete: ${failed.map((s) => s.name).join(", ")} failed.`);
    log(timedOut
      ? `  a step hit upstream's time limit (often a stalled package download). Wait until no bun process is left running, then run again: ${RETRY}`
      : `  fix the error below, then run again (the conversion is safe to repeat): ${RETRY}`);
    log("  upstream's diagnostics:");
  }
  for (const s of failed) {
    log(`  ${s.name} failed (exit ${s.exit ?? "?"})${s.reason ? `: ${s.reason}` : ""}`);
    const detail = s.tail ?? JSON.stringify(s.report ?? {}, null, 2);
    for (const line of detail.trim().split("\n").slice(-30)) log(`    ${line}`);
  }
  if (r.code !== 0 || report.ok === false || failed.length) throw new Error(`upstream's installer failed (${report.error ?? `exit ${r.code}`}); see above`);
}

/**
 * The USER scaffold is copied from templates that spell the default root (`~/.claude/...`),
 * and upstream code reads some of them back: ScaffoldUser follows `pulse_templates_dir` in
 * CUSTOMIZATIONS/SKILLS/LifeOS/Config.md on upgrade. Rebase every text file except MEMORY/,
 * which holds the user's own history.
 */
function rebaseUserTree(userTree: string, home: string, root: string, userData: string, skip: string[] = []): string[] {
  const changed: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (skip.includes(p)) continue;
      const st = lstatSync(p);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (p !== join(userTree, "MEMORY") && name !== ".git" && name !== "node_modules") walk(p);
        continue;
      }
      if (!st.isFile() || st.size > 1024 * 1024) continue;
      const buf = readFileSync(p);
      if (buf.includes(0)) continue;
      const { text, count } = rebaseDefaultRoot(buf.toString("utf8"), home, root, userData);
      if (count) {
        writeText(p, text);
        changed.push(p.slice(userTree.length + 1));
      }
    }
  };
  if (existsSync(userTree)) walk(userTree);
  return changed;
}

function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

/** The newest backup of `name` that upstream's OverlaySystem left in .lifeos-overlay-backups/. */
function newestBackup(root: string, name: string): string | null {
  const dir = join(root, ".lifeos-overlay-backups");
  if (!existsSync(dir)) return null;
  const found: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (lstatSync(p).isDirectory()) walk(p);
      else if (n.startsWith(name)) found.push(p);
    }
  };
  walk(dir);
  found.sort((a, b) => lstatSync(b).mtimeMs - lstatSync(a).mtimeMs);
  return found[0] ?? null;
}

function pruneSkillBackups(root: string): void {
  const dir = join(root, ".lifeos-skill-backups");
  if (!existsSync(dir)) return;
  const old = readdirSync(dir).filter((n) => n.startsWith("LifeOS.backup-")).sort().slice(0, -SKILL_BACKUPS_KEPT);
  for (const n of old) rmSync(join(dir, n), { recursive: true, force: true });
  if (old.length) log(`pruned ${old.length} old skill backup(s)`);
}

/** --check: report on a converted install without changing it. */
function check(root: string, home: string, pinFile: string): number {
  const say = (m: string) => console.log(`[check] ${m}`);
  const userData = join(root, USER_DATA);
  const state = readJson(join(root, STATE_DIR, "state.json"));
  if (!state.version) {
    say(`not converted yet: run bun ${join(root, "playbook/convert.ts")}`);
    return 1;
  }
  say(`LifeOS ${state.version} in ${root} (last conversion ${state.converted}, ${state.mode})`);
  let trouble = 0;
  const pin = readPin(pinFile);
  if (pin.version !== state.version || pin.commit !== state.commit) {
    say(`pin says ${pin.version} @ ${pin.commit.slice(0, 12)}, but ${state.version} is installed: run bun ${join(root, "playbook/convert.ts")}`);
    trouble++;
  } else say(`pin: matches (${pin.version} @ ${pin.commit.slice(0, 12)})`);
  const problems = auditInside(root, home, userData);
  if (problems.length) {
    say(`isolation: ${problems.length} problem(s); running the converter again repairs most of them:`);
    for (const p of problems) say(`  - ${p}`);
    trouble++;
  } else say("isolation: ok (settings, config path, USER and MEMORY links all inside the playbook)");
  const settings = readJson(join(root, "settings.json"));
  const env: Record<string, string | undefined> = { ...process.env, ...(settings.env ?? {}), CLAUDE_CONFIG_DIR: root };
  for (const k of REDIRECTING_ENV) delete env[k];
  const resolved = run("bun", ["-e", `const { lifeosUserDir } = await import(${JSON.stringify(join(root, "LIFEOS/TOOLS/LifeosConfig.ts"))}); console.log(lifeosUserDir())`], { cwd: root, env, capture: true, allowFail: true }).stdout.trim();
  if (resolved && existsSync(resolved) && realpathSync(resolved).startsWith(realpathSync(root) + "/")) say(`LifeOS reads its USER tree from ${resolved}`);
  else {
    say(`LifeOS resolves its USER tree to ${resolved || "(nothing)"}, outside the playbook: run the converter again`);
    trouble++;
  }
  if (problems.length) {
    // Doctor creates LIFEOS/MEMORY/STATE as it probes: with a mount missing, that would be a real
    // directory in the system tree instead of the data home.
    say("upstream Doctor: skipped until the converter repairs the problems above");
    say(trouble ? "needs attention: see above" : "healthy");
    return trouble ? 3 : 0;
  }
  const doctor = run("bun", [join(root, "LIFEOS/TOOLS/Doctor.ts")], { cwd: root, env, capture: true, allowFail: true });
  const lines = (doctor.stdout + doctor.stderr).split("\n");
  const broken = lines.filter((l) => l.includes("❌")).map((l) => l.trim());
  const live = lines.filter((l) => l.includes("✅")).length;
  say(`upstream Doctor, with this playbook's settings: ${live} live, ${broken.length} broken`);
  for (const b of broken) say(`  ${b}`);
  // Doctor's structural checks are the install's own health, not an optional tool.
  const structural = broken.filter((b) => /USER-data mounts|hook interpreter|orphaned memory/i.test(b));
  if (structural.length) {
    say("  the structural item(s) above mean the install itself is damaged: run the converter again");
    trouble++;
  }
  const identity = broken.some((b) => /identity placeholders/i.test(b));
  if (identity) say("  (identity placeholders stay unrendered until you run /LifeOS setup in a session)");
  if (broken.length > structural.length + (identity ? 1 : 0)) say("  (missing optional tools only disable the features Doctor names)");
  say(trouble ? "needs attention: see above" : "healthy");
  return trouble ? 3 : 0;
}

function main(): number {
  const o = parseArgs(process.argv.slice(2));
  const home = homedir();
  const root = o.root;
  if (o.check) {
    if (!existsSync(join(root, ".playbook"))) throw new Refusal(`${root} has no .playbook: not a playbook root`);
    return check(root, home, o.pin);
  }
  preflight(root, home);
  RETRY = retryCommand(o);
  let pin;
  try {
    pin = readPin(o.pin);
  } catch (e) {
    throw new Refusal(`cannot read the release pin ${o.pin}: ${e instanceof Error ? e.message : e}. Restore it from the playbook source (cpb update <name>) or point --pin at a valid pin file`);
  }
  const userData = join(root, USER_DATA);
  const stateDir = join(root, STATE_DIR);
  const tmp = join(stateDir, "tmp");
  const installed = installedVersion(root);
  const mode = installed ? "upgrade" : "fresh";

  if (installed && compareVersions(pin.version, installed) < 0 && !o.allowDowngrade)
    throw new Refusal(`installed LifeOS ${installed} is newer than the pin ${pin.version}, so nothing was changed. To go back to ${pin.version} on purpose: ${RETRY} --allow-downgrade`);

  log(`root      ${root}`);
  log(`release   ${pin.repo} ${pin.version} @ ${pin.commit.slice(0, 12)}`);
  log(`mode      ${mode}${installed ? ` (installed ${installed})` : ""}`);
  log(`user data ${userData}`);
  log(`source    ${o.src ?? `fetch github.com/${pin.repo} ${pin.commit}`}`);
  if (o.migrateFrom || o.migrateTo) log(`cpb update ${o.migrateFrom ?? "?"} -> ${o.migrateTo ?? "?"}`);
  const missingPrereqs = missingPrerequisites();
  const cache = bunCacheFallback(home, stateDir);
  if (cache) log(`bun's package cache ${cache.shared} is not writable by you, so the conversion uses ${cache.local} instead (more downloading, the same result). To share bun's cache again: ${cache.fix}`);
  if (o.plan) {
    log(`plan only: components ${WANTED_COMPONENTS.join(",")} (minus any the release lacks); all core services declined`);
    if (missingPrereqs.length) {
      for (const m of missingPrereqs) log(`not ready: ${m}`);
      log(`then check again: ${RETRY} --plan`);
      return 2;
    }
    log(`ready: local prerequisites are in place (network access and the lock are checked when it runs). Next: ${RETRY}`);
    return 0;
  }
  if (missingPrereqs.length) throw new Refusal(missingPrereqs.join("; "));

  mkdirConfined(stateDir);
  const unlock = lock(stateDir);
  const staging = o.src ?? join(stateDir, "staging", pin.commit);
  let ok = false;
  try {
    const before = snapshot(home);

    // 1. Source.
    if (o.src) {
      if (!o.unverifiedSrc) verifyLocalSource(o.src, pin.commit);
    } else {
      log(`fetching LifeOS ${pin.version} (commit ${pin.commit.slice(0, 12)}) from github.com/${pin.repo}`);
      try {
        fetchCommit(pin.repo, pin.commit, staging);
      } catch (e) {
        throw new Error(`could not download LifeOS ${pin.version} (${pin.commit.slice(0, 12)}) from https://github.com/${pin.repo}: check the network, then run again: ${RETRY}\n  offline alternative: a local checkout of that repo at that commit, passed with --src <dir>\n  git said: ${e instanceof Error ? e.message.split("\n").slice(-3).join(" ") : e}`);
      }
    }
    const skillSrc = join(staging, pin.subpath);
    for (const f of ["install/install.sh", "Tools/InstallAll.ts", "install/LIFEOS/VERSION"])
      if (!existsSync(join(skillSrc, f)))
        throw new Error(o.src
          ? `${join(o.src, pin.subpath, f)} does not exist: --src must name the repository root (the directory that contains ${pin.subpath}/), not the skill directory`
          : `release ${pin.version} has no ${pin.subpath}/${f}: upstream changed its layout, so this converter needs an update`);
    const payloadVersion = readFileSync(join(skillSrc, "install/LIFEOS/VERSION"), "utf8").trim();
    if (payloadVersion !== pin.version) throw new Error(`release payload says ${payloadVersion}, the pin says ${pin.version}`);

    // 2. Pre-seed. InstallSettings only adds missing keys, so these win.
    mkdirConfined(userData);
    rmSync(tmp, { recursive: true, force: true });
    mkdirConfined(tmp);
    const settingsPath = join(root, "settings.json");
    const env = upstreamEnv(root, userData, tmp);
    if (cache) {
      mkdirConfined(cache.local);
      env.BUN_INSTALL_CACHE_DIR = cache.local;
    }
    const snapshotPath = join(root, SNAPSHOT);
    if (installed && existsSync(snapshotPath)) {
      // Fold hand edits made since the last merge into the user layer before anything rewrites
      // settings.json -- the same backport upstream's SessionStart hook runs. First, so that a
      // refusal really leaves the install as it was.
      const b = run("bun", [join(root, "LIFEOS/TOOLS/SettingsBackport.ts")], { cwd: root, env, capture: true, allowFail: true });
      const lastLine = (t: string) => t.trim().split("\n").pop() ?? "";
      // On failure the reason is on stderr; stdout only says how many changes were written.
      const said = (b.code !== 0 ? lastLine(b.stderr) || lastLine(b.stdout) : lastLine(b.stdout) || lastLine(b.stderr)) || `exit ${b.code}`;
      if (b.code !== 0 && !o.skipBackport)
        throw new Error(`could not carry your settings.json edits into the user layer before upgrading (SettingsBackport: ${said}). Nothing has been changed. Keep a copy of ${settingsPath}, fix the error, then run again: ${RETRY}\n  to upgrade anyway, accepting that edits not yet in the user layer may be lost: ${RETRY} --skip-settings-backport`);
      log(`settings edits carried into the user layer before the upgrade (${said})`);
    }
    const claudeMd = join(root, "CLAUDE.md");
    let claudeBefore: string | null = null;
    if (existsSync(claudeMd) && isBootstrap(readFileSync(claudeMd, "utf8"))) {
      // InstallSettings writes upstream's CLAUDE.md only when none exists.
      renameSync(claudeMd, join(stateDir, "bootstrap-CLAUDE.md"));
    } else if (existsSync(claudeMd)) {
      // Compare with what the last completed conversion wrote: only a user's own edit counts.
      const last = readJson(join(stateDir, "state.json")).claudeMdSha;
      const text = readFileSync(claudeMd, "utf8");
      if (typeof last === "string" && last !== sha256(text)) claudeBefore = stripSection(text);
    }
    const rootEnv = rootEnvFor(root, userData);
    const settings = readJson(settingsPath);
    forceEnv(settings, rootEnv);
    writeJson(settingsPath, settings);
    if (!existsSync(join(root, ".git"))) run("git", ["init", "-q", root], { capture: true });


    // 3. Place the skill with the release's own installer.
    log("placing the LifeOS skill (the release's install.sh)");
    // Captured: its onboarding text ("Open your harness and run ...") is for a plain install.
    const placed = run("bash", [join(skillSrc, "install/install.sh")], {
      cwd: root,
      capture: true,
      allowFail: true,
      env: {
        ...env,
        LIFEOS_SRC: staging,
        LIFEOS_RELEASE_SUBPATH: pin.subpath,
        LIFEOS_VERSION: pin.version,
        LIFEOS_SKIP_ALIAS: "1",
        LIFEOS_NO_LAUNCH: "1",
        LIFEOS_AUTO_INSTALL_BUN: "0",
      },
    });
    if (placed.code !== 0) {
      for (const line of (placed.stdout + placed.stderr).trim().split("\n").slice(-25)) log(`  ${line}`);
      throw new Error(`the release's install.sh failed (exit ${placed.code}); its last lines are above`);
    }
    const skillRoot = join(root, "skills", "LifeOS");

    // 4. Run the release's InstallAll with the playbook policy.
    const listed = run("bun", [join(skillRoot, "install/LIFEOS/TOOLS/Services.ts"), "list", "--json"], { cwd: root, env, capture: true });
    const declined = coreServices(listed.stdout);
    const offered = documentedComponents(readFileSync(join(skillRoot, "Tools/DeployComponents.ts"), "utf8"));
    const { use, missing } = pickComponents(WANTED_COMPONENTS, offered);
    if (missing.length) log(`release no longer offers: ${missing.join(", ")}`);
    log(`installing: components ${use.join(",") || "(none)"}; declining services ${declined.join(",") || "(none)"}`);
    log(`running upstream's installer (${installed ? "upgrade" : "fresh install"}): installs packages${process.platform === "linux" ? " and compiles native modules" : ""}, usually 1-3 minutes with no output until it finishes`);
    const installArgs = [join(skillRoot, "Tools/InstallAll.ts"), "--yes", "--json", "--config-root", root, "--skill-root", skillRoot];
    // An empty --components deploys the default set, which includes components that write outside the root.
    if (!use.length) throw new Error(`release offers none of ${WANTED_COMPONENTS.join(",")}: upstream changed its components`);
    installArgs.push("--components", use.join(","));
    if (declined.length) installArgs.push("--decline-services", declined.join(","));
    // Upstream's upgrade chain always runs RefreshStatusline, which schedules a machine-wide
    // launchd job (com.lifeos.workflows-dispatcher) when settings.json uses the shipped
    // statusline. Hide it from that one check, then put it back.
    const live = readJson(settingsPath);
    const statusLine = live.statusLine;
    const stash = installed !== null && typeof statusLine?.command === "string" && statusLine.command.includes("LIFEOS_StatusLine.sh");
    if (stash) {
      delete live.statusLine;
      writeJson(settingsPath, live);
      log("statusline: set aside during the upgrade so upstream schedules no machine-wide refresher job");
    }
    try {
      installAll(installArgs, root, env);
    } finally {
      if (stash) {
        const after = readJson(settingsPath);
        after.statusLine = statusLine;
        writeJson(settingsPath, after);
      }
    }
    // Upstream's upgrade chain re-merges hooks only where some are already wired. A fresh
    // install interrupted between LinkUser and InstallHooks reruns as an upgrade with none.
    if (installed !== null && hookProblems(readJson(settingsPath)).length) {
      log("hooks: not registered (an earlier conversion stopped before upstream's InstallHooks); registering them now");
      run("bun", [join(skillRoot, "Tools/InstallHooks.ts"), "--config-root", root, "--skill-root", skillRoot, "--apply"], { cwd: root, env, capture: true });
    }

    // 5. Establish the system settings layer on a fresh install too. Upstream creates it only on
    // upgrade, and until then its SessionStart backport throws (it reads settings.system.json
    // first) and the rebuild no-ops, so hand edits to settings.json never reach the user layer
    // and the first rebuild after an upgrade drops them.
    const systemLayer = join(root, "settings.system.json");
    if (!existsSync(systemLayer)) {
      writeText(systemLayer, readFileSync(join(skillRoot, "install/settings.system.json"), "utf8"));
      log("settings.system.json: established, so the per-session settings rebuild and backport work from the first session");
    }

    // Rebase what upstream leaves pointing at ~/.claude.
    for (const f of ["settings.json", "settings.system.json"]) {
      const p = join(root, f);
      if (!existsSync(p)) continue;
      const { settings: obj, count } = rebaseSettings(readJson(p), home, root, userData);
      forceEnv(obj, rootEnv);
      writeJson(p, obj);
      if (count) log(`${f}: rebased ${count} default-profile path(s)`);
    }
    const userLayer = join(root, USER_LAYER);
    const userFiles = rebaseUserTree(join(userData, "USER"), home, root, userData, [userLayer]);
    if (userFiles.length) log(`USER tree: rebased default-profile paths in ${userFiles.length} file(s) (listed in .lifeos-playbook/state.json)`);
    // MergeSettings rebuilds settings.json from settings.system.json + the user layer each
    // session and keeps nothing else, so the keys cpb writes must live in the user layer too.
    if (existsSync(dirname(userLayer))) {
      const p = userLayer;
      const rebased = rebaseSettings(readJson(p), home, root, userData);
      const layer = rebased.settings;
      let changed = forceEnv(layer, rootEnv).length > 0 || rebased.count > 0;
      const live = readJson(settingsPath);
      const system = readJson(systemLayer);
      // The snapshot still holds the previous run's merge; it is rewritten below.
      const kept = preserveKeys(live, system, layer, CPB_KEYS, existsSync(snapshotPath) ? readJson(snapshotPath) : undefined);
      if (kept.length) {
        changed = true;
        log(`user settings layer: kept cpb key(s) ${kept.join(", ")} across the per-session rebuild`);
      }
      if (changed) writeJson(p, layer);
    }

    // 6. CLAUDE.md section. Upstream's upgrade overwrites CLAUDE.md with its template (the old
    // one goes to .lifeos-overlay-backups/); the section imports CLAUDE.local.md, which nothing
    // overwrites, so personal instructions belong there.
    let claudeReplaced = false;
    if (existsSync(claudeMd)) {
      const current = readFileSync(claudeMd, "utf8");
      claudeReplaced = claudeBefore !== null && claudeBefore !== stripSection(current);
      writeText(claudeMd, upsertSection(current, playbookSection({ root, userData, version: pin.version, commit: pin.commit })));
      if (claudeReplaced)
        log(`your edits to CLAUDE.md were replaced by upstream's template; your version is saved at ${newestBackup(root, "CLAUDE.md") ?? ".lifeos-overlay-backups/"}. Move personal instructions to CLAUDE.local.md, which updates never touch`);
    }
    pruneSkillBackups(root);

    // A merge snapshot equal to the converted settings.json: hand edits made from here on are
    // drift that upstream's SessionStart backport carries into the user layer. Without one the
    // backport skips and the first rebuild after an upgrade drops those edits.
    mkdirConfined(dirname(snapshotPath));
    writeJson(snapshotPath, readJson(settingsPath));
    // Then the rebuild every session starts with, so settings.json already holds this release's
    // system layer merged with the user layer (not the previous release's merge until the first
    // session). The snapshot above makes its backport a no-op: the converter's own changes are
    // not hand edits.
    const rebuild = sessionStartCommands(readJson(settingsPath)).find((c) => /MergeSettings/.test(c));
    if (rebuild) {
      const r = run("sh", ["-c", rebuild], { cwd: root, env, capture: true, allowFail: true });
      if (r.code !== 0) {
        const said = (r.stderr.trim() || r.stdout.trim()).split("\n").pop() || `exit ${r.code}`;
        throw new Error(`LifeOS ${pin.version} is installed, but upstream's settings rebuild failed (${said}), so settings.json still holds the previous merge and every session start will fail the same way. Check ${join(USER_DATA, "USER", "CONFIG", "settings.user.json")} (the user layer it merges), then run again: ${RETRY}`);
      }
      writeJson(snapshotPath, readJson(settingsPath));
    }

    // 7. Audit.
    const inside = auditInside(root, home, userData);
    const outside = diffSnapshots(before, snapshot(home));
    const problems = [...inside, ...outside.map((d) => `outside the root: ${d}`)];
    writeJson(join(stateDir, "state.json"), {
      version: pin.version,
      commit: pin.commit,
      converted: stamp(),
      mode,
      from: installed,
      components: use,
      declinedServices: declined,
      claudeMdReplaced: claudeReplaced,
      claudeMdSha: existsSync(claudeMd) ? sha256(readFileSync(claudeMd, "utf8")) : null,
      rebasedUserFiles: userFiles,
      problems,
    });
    ok = true;
    if (problems.length) {
      log(`converted, but the isolation audit found ${problems.length} problem(s) (exit 3):`);
      for (const p of problems) log(`  - ${p}`);
      log(`running the converter again repairs settings and links: ${RETRY}`);
      log("changes outside the playbook are reported, not undone: check them yourself");
      log(`full report: ${join(stateDir, "state.json")}`);
      return 3;
    }
    log(`done: LifeOS ${pin.version} is installed in ${root}`);
    if (mode === "fresh") log("next: start the playbook (its launcher, or cpb run <name>) and type /LifeOS setup to begin the interview");
    else log("next: restart any open sessions of this playbook so they load the new settings and hooks");
    return 0;
  } finally {
    // The lock goes last: the next conversion may start the moment it is released.
    try {
      rmSync(tmp, { recursive: true, force: true });
      if (ok && !o.src && !o.keepStaging) rmSync(join(stateDir, "staging"), { recursive: true, force: true });
      else if (!ok && !o.src && existsSync(staging)) log(`fetched source kept at ${staging}; the next run reuses or replaces it`);
    } finally {
      unlock();
    }
  }
}

try {
  process.exit(main());
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  if (e instanceof Refusal) {
    console.error(`[convert] refused: ${msg}`);
    process.exit(2);
  }
  console.error(`[convert] failed: ${msg}`);
  process.exit(1);
}
