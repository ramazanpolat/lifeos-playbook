#!/usr/bin/env bun
/**
 * convert -- turn the pinned upstream LifeOS release into this playbook.
 *
 *   bun playbook/convert.ts            # convert (fresh install, or upgrade in place)
 *   bun playbook/convert.ts --plan     # print what would happen, change nothing
 *
 * Flags: --root <dir>        playbook root (default: the playbook this script lives in)
 *        --pin <file>        pin file (default: playbook/upstream.json)
 *        --src <dir>         local upstream checkout at the pinned commit, instead of fetching
 *        --unverified-src    accept --src without checking its commit
 *        --allow-downgrade   convert a release older than the installed one
 *        --keep-staging      keep the fetched source after a successful run
 *        --migrate-from <v> --migrate-to <v>   set by bin/migrate (cpb update), logged only
 *
 * The conversion is a policy over upstream's own installer, not a rewrite of it:
 *   1. fetch the pinned commit and prove HEAD is that commit
 *   2. pre-seed settings.json so the data home and LIFEOS dir resolve inside the root
 *   3. place the skill with the release's own install.sh (no alias edits, no launch)
 *   4. run the release's InstallAll.ts with the config root set to the playbook, every
 *      core service declined, and only components that stay inside the root
 *   5. rebase the default-profile paths upstream leaves in settings files
 *   6. append the playbook section to CLAUDE.md
 *   7. audit: nothing inside points at ~/.claude, nothing outside the root changed
 *
 * Exit: 0 converted and clean (with --plan: ready), 1 failed, 2 refused (preflight; with --plan:
 *       not ready, the missing prerequisite is named), 3 converted but the audit found problems.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { auditInside, diffSnapshots, snapshot } from "./lib/audit";
import { coreServices, forceEnv, isBootstrap, pickComponents, playbookSection, preserveKeys, rebaseDefaultRoot, rebaseSettings, stripSection, upsertSection } from "./lib/patch";
import { compareVersions, fetchCommit, readPin, stamp, verifyLocalSource } from "./lib/pin";
import { run } from "./lib/sh";

/** Components that write only inside the root. statusline, helm, pulse, worksweep and derivedsync write outside it. */
const WANTED_COMPONENTS = ["tooltips", "spinnerverbs", "agents", "commands", "workflows"];
const USER_DATA = "user-data";
const STATE_DIR = ".lifeos-playbook";
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
  plan: boolean;
  migrateFrom?: string;
  migrateTo?: string;
}

function parseArgs(argv: string[]): Opts {
  const here = import.meta.dir;
  const o: Opts = { root: dirname(here), pin: join(here, "upstream.json"), unverifiedSrc: false, allowDowngrade: false, keepStaging: false, plan: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Refusal(`${a} needs a value`);
      return v;
    };
    if (a === "--root") o.root = val();
    else if (a === "--pin") o.pin = val();
    else if (a === "--src") o.src = resolve(val());
    else if (a === "--unverified-src") o.unverifiedSrc = true;
    else if (a === "--allow-downgrade") o.allowDowngrade = true;
    else if (a === "--keep-staging") o.keepStaging = true;
    else if (a === "--plan") o.plan = true;
    else if (a === "--migrate-from") o.migrateFrom = val();
    else if (a === "--migrate-to") o.migrateTo = val();
    else if (a === "-h" || a === "--help") {
      console.log(readFileSync(import.meta.path, "utf8").split("*/")[0]);
      process.exit(0);
    } else throw new Refusal(`unknown argument: ${a}`);
  }
  o.root = resolve(o.root);
  return o;
}

const log = (m: string) => console.log(`[convert] ${m}`);

function preflight(root: string, home: string): void {
  if (!existsSync(join(root, ".playbook"))) throw new Refusal(`${root} has no .playbook: not a playbook root`);
  if (/\s/.test(root)) throw new Refusal(`playbook root contains whitespace (${root}); upstream hook commands would break`);
  const def = join(home, ".claude");
  if (existsSync(def) && realpathSync(root) === realpathSync(def)) throw new Refusal("refusing to convert the default profile ~/.claude");
  // Every path the conversion writes must stay inside the root, symlinks resolved: a
  // settings.json linked to ~/.claude/settings.json would be written through.
  const realRoot = realpathSync(root);
  for (const rel of ["settings.json", "settings.system.json", "CLAUDE.md", USER_DATA, STATE_DIR, "LIFEOS", "skills", "hooks", "agents", "commands", "workflows", ".git", ".gitignore"]) {
    const p = join(root, rel);
    if (!existsSync(p)) continue;
    const real = realpathSync(p);
    if (real !== realRoot && !real.startsWith(realRoot + "/")) throw new Refusal(`${rel} resolves outside the playbook (${real}); the conversion would write through it`);
  }
  const v = run("bun", ["--version"], { capture: true }).stdout.trim();
  const [maj, min] = v.split(".").map(Number);
  if (maj < BUN_MIN[0] || (maj === BUN_MIN[0] && min < BUN_MIN[1])) throw new Refusal(`bun ${v} is too old; LifeOS needs ${BUN_MIN.join(".")}+`);
  run("git", ["--version"], { capture: true });
}

/** Prerequisites the conversion needs but --plan only reports. */
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

function writeJson(p: string, v: unknown): void {
  writeFileSync(p, JSON.stringify(v, null, 2) + "\n");
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
function upstreamEnv(root: string, userData: string, tmp: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  // Each of these outranks or redirects the config root (TOOLS/Paths.ts, OverlaySystem, InstallHooks).
  for (const k of ["CLAUDE_PLUGIN_ROOT", "LIFEOS_HARNESS", "LIFEOS_TAG", "LIFEOS_TARBALL_URL", "LIFEOS_EXPECTED_SHA256", "DRY_RUN"]) delete env[k];
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
  const mine = String(process.pid);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(f, mine, { flag: "wx" });
      return () => {
        try {
          if (readFileSync(f, "utf8").trim() === mine) rmSync(f, { force: true });
        } catch {}
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const pid = Number(readFileSync(f, "utf8").trim());
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {}
    if (alive) throw new Refusal(`another conversion is running (pid ${pid}); wait for it to finish, or remove ${f} if that process is not a conversion`);
    log(`taking over the lock of pid ${pid}, which is no longer running (an interrupted conversion)`);
    rmSync(f, { force: true });
  }
  throw new Refusal(`could not take the lock ${f}: another conversion started at the same moment`);
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
  let report: { ok?: boolean; mode?: string; error?: string; steps?: InstallStep[] };
  try {
    report = JSON.parse(r.stdout);
  } catch {
    throw new Error(`InstallAll exited ${r.code} without a JSON report:\n${(r.stderr || r.stdout).trim().split("\n").slice(-20).join("\n")}`);
  }
  log(`InstallAll (${report.mode ?? "?"}): ${(report.steps ?? []).map((s) => `${s.name} ${s.status}`).join(", ")}`);
  const failed = (report.steps ?? []).filter((s) => s.status === "failed");
  for (const s of failed) {
    log(`  ${s.name} failed (exit ${s.exit ?? "?"})${s.reason ? `: ${s.reason}` : ""}`);
    const detail = s.tail ?? JSON.stringify(s.report ?? {}, null, 2);
    for (const line of detail.trim().split("\n").slice(-30)) log(`    ${line}`);
  }
  if (failed.some((s) => /timed out/.test(s.reason ?? "")))
    log("  an upstream step hit its time limit, usually a stalled `bun install` on a cold cache; the conversion is safe to run again once it has exited");
  if (r.code !== 0 || report.ok === false || failed.length) throw new Error(`InstallAll failed: ${report.error ?? `exit ${r.code}`}`);
}

/**
 * The USER scaffold is copied from templates that spell the default root (`~/.claude/...`),
 * and upstream code reads some of them back: ScaffoldUser follows `pulse_templates_dir` in
 * CUSTOMIZATIONS/SKILLS/LifeOS/Config.md on upgrade. Rebase every text file except MEMORY/,
 * which holds the user's own history.
 */
function rebaseUserTree(userTree: string, home: string, root: string, skip: string[] = []): string[] {
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
      const { text, count } = rebaseDefaultRoot(buf.toString("utf8"), home, root);
      if (count) {
        writeFileSync(p, text);
        changed.push(p.slice(userTree.length + 1));
      }
    }
  };
  if (existsSync(userTree)) walk(userTree);
  return changed;
}

function pruneSkillBackups(root: string): void {
  const dir = join(root, ".lifeos-skill-backups");
  if (!existsSync(dir)) return;
  const old = readdirSync(dir).filter((n) => n.startsWith("LifeOS.backup-")).sort().slice(0, -SKILL_BACKUPS_KEPT);
  for (const n of old) rmSync(join(dir, n), { recursive: true, force: true });
  if (old.length) log(`pruned ${old.length} old skill backup(s)`);
}

function main(): number {
  const o = parseArgs(process.argv.slice(2));
  const home = homedir();
  const root = o.root;
  preflight(root, home);
  const pin = readPin(o.pin);
  const userData = join(root, USER_DATA);
  const stateDir = join(root, STATE_DIR);
  const tmp = join(stateDir, "tmp");
  const installed = installedVersion(root);
  const mode = installed ? "upgrade" : "fresh";

  if (installed && compareVersions(pin.version, installed) < 0 && !o.allowDowngrade)
    throw new Refusal(`installed LifeOS ${installed} is newer than the pin ${pin.version}; pass --allow-downgrade to go back`);

  log(`root      ${root}`);
  log(`release   ${pin.repo} ${pin.version} @ ${pin.commit.slice(0, 12)}`);
  log(`mode      ${mode}${installed ? ` (installed ${installed})` : ""}`);
  log(`user data ${userData}`);
  log(`source    ${o.src ?? `fetch github.com/${pin.repo} ${pin.commit}`}`);
  if (o.migrateFrom || o.migrateTo) log(`cpb update ${o.migrateFrom ?? "?"} -> ${o.migrateTo ?? "?"}`);
  const missingPrereqs = missingPrerequisites();
  if (o.plan) {
    log(`plan only: components ${WANTED_COMPONENTS.join(",")} (minus any the release lacks); all core services declined`);
    if (missingPrereqs.length) {
      for (const m of missingPrereqs) log(`not ready: ${m}`);
      return 2;
    }
    log("ready: run the same command without --plan to convert");
    return 0;
  }
  if (missingPrereqs.length) throw new Refusal(missingPrereqs.join("; "));

  mkdirSync(stateDir, { recursive: true });
  const unlock = lock(stateDir);
  const staging = o.src ?? join(stateDir, "staging", pin.commit);
  let ok = false;
  try {
    const before = snapshot(home);

    // 1. Source.
    if (o.src) {
      if (!o.unverifiedSrc) verifyLocalSource(o.src, pin.commit);
    } else {
      log("fetching the pinned commit");
      fetchCommit(pin.repo, pin.commit, staging);
    }
    const skillSrc = join(staging, pin.subpath);
    for (const f of ["install/install.sh", "Tools/InstallAll.ts", "install/LIFEOS/VERSION"])
      if (!existsSync(join(skillSrc, f))) throw new Error(`release has no ${pin.subpath}/${f}: upstream layout changed`);
    const payloadVersion = readFileSync(join(skillSrc, "install/LIFEOS/VERSION"), "utf8").trim();
    if (payloadVersion !== pin.version) throw new Error(`release payload says ${payloadVersion}, the pin says ${pin.version}`);

    // 2. Pre-seed. InstallSettings only adds missing keys, so these win.
    mkdirSync(userData, { recursive: true });
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    const claudeMd = join(root, "CLAUDE.md");
    let claudeBefore: string | null = null;
    if (existsSync(claudeMd) && isBootstrap(readFileSync(claudeMd, "utf8"))) {
      // InstallSettings writes upstream's CLAUDE.md only when none exists.
      renameSync(claudeMd, join(stateDir, "bootstrap-CLAUDE.md"));
    } else if (existsSync(claudeMd)) {
      claudeBefore = stripSection(readFileSync(claudeMd, "utf8"));
    }
    const rootEnv = rootEnvFor(root, userData);
    const settingsPath = join(root, "settings.json");
    const settings = readJson(settingsPath);
    forceEnv(settings, rootEnv);
    writeJson(settingsPath, settings);
    if (!existsSync(join(root, ".git"))) run("git", ["init", "-q", root], { capture: true });

    const env = upstreamEnv(root, userData, tmp);
    const snapshotPath = join(root, "LIFEOS", "MEMORY", "STATE", "settings-merge-snapshot.json");
    if (installed && existsSync(snapshotPath)) {
      // Fold hand edits made since the last merge into the user layer before anything rewrites
      // settings.json -- the same backport upstream's SessionStart hook runs.
      const b = run("bun", [join(root, "LIFEOS/TOOLS/SettingsBackport.ts")], { cwd: root, env, capture: true, allowFail: true });
      log(`settings backport before upgrade: ${(b.stdout || b.stderr).trim().split("\n").pop() ?? `exit ${b.code}`}`);
    }

    // 3. Place the skill with the release's own installer.
    log("placing the skill (release install.sh)");
    run("bash", [join(skillSrc, "install/install.sh")], {
      cwd: root,
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
    const skillRoot = join(root, "skills", "LifeOS");

    // 4. Run the release's InstallAll with the playbook policy.
    const listed = run("bun", [join(skillRoot, "install/LIFEOS/TOOLS/Services.ts"), "list", "--json"], { cwd: root, env, capture: true });
    const declined = coreServices(listed.stdout);
    const offered = documentedComponents(readFileSync(join(skillRoot, "Tools/DeployComponents.ts"), "utf8"));
    const { use, missing } = pickComponents(WANTED_COMPONENTS, offered);
    if (missing.length) log(`release no longer offers: ${missing.join(", ")}`);
    log(`installing: components ${use.join(",") || "(none)"}; declining services ${declined.join(",") || "(none)"}`);
    const installArgs = [join(skillRoot, "Tools/InstallAll.ts"), "--yes", "--json", "--config-root", root, "--skill-root", skillRoot];
    // An empty --components deploys the default set, which includes components that write outside the root.
    if (!use.length) throw new Error(`release offers none of ${WANTED_COMPONENTS.join(",")}: upstream changed its components`);
    installArgs.push("--components", use.join(","));
    if (declined.length) installArgs.push("--decline-services", declined.join(","));
    installAll(installArgs, root, env);

    // 5. Rebase what upstream leaves pointing at ~/.claude.
    for (const f of ["settings.json", "settings.system.json"]) {
      const p = join(root, f);
      if (!existsSync(p)) continue;
      const { settings: obj, count } = rebaseSettings(readJson(p), home, root);
      forceEnv(obj, rootEnv);
      writeJson(p, obj);
      if (count) log(`${f}: rebased ${count} default-profile path(s)`);
    }
    const userLayer = join(userData, "USER", "CONFIG", "settings.user.json");
    const userFiles = rebaseUserTree(join(userData, "USER"), home, root, [userLayer]);
    if (userFiles.length) log(`USER tree: rebased default-profile paths in ${userFiles.length} file(s): ${userFiles.join(", ")}`);
    // MergeSettings rebuilds settings.json from settings.system.json + the user layer each
    // session and keeps nothing else, so the keys cpb writes must live in the user layer too.
    if (existsSync(dirname(userLayer))) {
      const p = userLayer;
      const rebased = rebaseSettings(readJson(p), home, root);
      const layer = rebased.settings;
      let changed = forceEnv(layer, rootEnv).length > 0 || rebased.count > 0;
      const live = readJson(settingsPath);
      const sysPath = existsSync(join(root, "settings.system.json")) ? join(root, "settings.system.json") : join(skillRoot, "install/settings.system.json");
      const system = readJson(sysPath);
      const kept = preserveKeys(live, system, layer, CPB_KEYS);
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
      writeFileSync(claudeMd, upsertSection(current, playbookSection({ root, userData, version: pin.version, commit: pin.commit })));
      if (claudeReplaced)
        log("CLAUDE.md now holds upstream's template; the previous one is in .lifeos-overlay-backups/. Keep personal instructions in CLAUDE.local.md, which updates never touch");
    }
    pruneSkillBackups(root);

    // A merge snapshot equal to the converted settings.json: hand edits made from here on are
    // drift that upstream's SessionStart backport carries into the user layer. Without one the
    // backport skips and the first rebuild after an upgrade drops those edits.
    mkdirSync(dirname(snapshotPath), { recursive: true });
    writeJson(snapshotPath, readJson(settingsPath));

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
      problems,
    });
    ok = true;
    if (problems.length) {
      log(`converted, but the audit found ${problems.length} problem(s):`);
      for (const p of problems) log(`  - ${p}`);
      return 3;
    }
    log(`done: LifeOS ${pin.version} is installed in ${root}${mode === "fresh" ? "; start the playbook and run /LifeOS setup to begin the interview" : ""}`);
    return 0;
  } finally {
    unlock();
    rmSync(tmp, { recursive: true, force: true });
    if (ok && !o.src && !o.keepStaging) rmSync(join(stateDir, "staging"), { recursive: true, force: true });
    else if (!ok && !o.src) log(`source kept for diagnosis: ${staging}`);
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
