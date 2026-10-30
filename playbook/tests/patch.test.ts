import { describe, expect, test } from "bun:test";
import {
  BOOTSTRAP_MARKER,
  SECTION_BEGIN,
  SECTION_END,
  coreServices,
  findDefaultRoot,
  forceEnv,
  isBootstrap,
  pickComponents,
  preserveKeys,
  rebaseSettings,
  stripSection,
  playbookSection,
  rebaseDefaultRoot,
  upsertSection,
} from "../lib/patch";
import { compareVersions, validatePin } from "../lib/pin";
import { diffSnapshots, hookProblems, writeTarget } from "../lib/audit";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = "/home/user";
const ROOT = "/home/user/.claude-playbooks/lifeos";

describe("rebaseDefaultRoot", () => {
  test("rewrites every spelling of the default root", () => {
    const src = `"~/.claude/x" "$HOME/.claude/hooks/a.ts" "\${HOME}/.claude" "/home/user/.claude/LIFEOS" Edit(~/.claude/**)`;
    const { text, count } = rebaseDefaultRoot(src, HOME, ROOT);
    expect(count).toBe(5);
    expect(text).toBe(`"${ROOT}/x" "${ROOT}/hooks/a.ts" "${ROOT}" "${ROOT}/LIFEOS" Edit(${ROOT}/**)`);
  });

  test("leaves look-alikes alone", () => {
    const src = `~/.claude-playbooks/other ~/.claude.json $HOME/.claudex /other/home/.claude/x`;
    expect(rebaseDefaultRoot(src, HOME, ROOT)).toEqual({ text: src, count: 0 });
  });

  test("matches at end of string and before punctuation", () => {
    expect(rebaseDefaultRoot("~/.claude", HOME, ROOT).text).toBe(ROOT);
    expect(rebaseDefaultRoot("a ~/.claude, b", HOME, ROOT).text).toBe(`a ${ROOT}, b`);
  });

  test("matches in markdown prose and shell defaults", () => {
    expect(rebaseDefaultRoot("else `~/.claude`)", HOME, ROOT).text).toBe(`else \`${ROOT}\`)`);
    expect(rebaseDefaultRoot("<path relative to ~/.claude>", HOME, ROOT).text).toBe(`<path relative to ${ROOT}>`);
    expect(rebaseDefaultRoot("${X:-$HOME/.claude}", HOME, ROOT).text).toBe(`\${X:-${ROOT}}`);
    expect(rebaseDefaultRoot("[~/.claude]", HOME, ROOT).text).toBe(`[${ROOT}]`);
    expect(rebaseDefaultRoot("lives in ~/.claude.", HOME, ROOT).text).toBe(`lives in ${ROOT}.`);
  });

  test("a home path inside another path is not the default root", () => {
    const src = "/backup/home/user/.claude/skills/LifeOS/install/USER";
    expect(rebaseDefaultRoot(src, HOME, ROOT)).toEqual({ text: src, count: 0 });
    expect(rebaseDefaultRoot("x/~/.claude y", HOME, ROOT).count).toBe(0);
    expect(rebaseDefaultRoot("KEY=$HOME/.claude/x", HOME, ROOT).text).toBe(`KEY=${ROOT}/x`);
  });

  test("a dot followed by a word is a different file", () => {
    expect(rebaseDefaultRoot("~/.claude.json ~/.claude.bak/x", HOME, ROOT).count).toBe(0);
  });

  test("is idempotent", () => {
    const once = rebaseDefaultRoot(`"$HOME/.claude/x"`, HOME, ROOT).text;
    expect(rebaseDefaultRoot(once, HOME, ROOT)).toEqual({ text: once, count: 0 });
    expect(findDefaultRoot(once, HOME)).toEqual([]);
  });
});

describe("forceEnv", () => {
  test("creates env and reports only changed keys", () => {
    const s: Record<string, any> = {};
    expect(forceEnv(s, { A: "1", B: "2" })).toEqual(["A", "B"]);
    expect(forceEnv(s, { A: "1", B: "3" })).toEqual(["B"]);
    expect(s.env).toEqual({ A: "1", B: "3" });
  });
});

describe("CLAUDE.md section", () => {
  const section = playbookSection({ root: ROOT, userData: `${ROOT}/user-data`, version: "8.761.0", commit: "f".repeat(40) });

  test("appends once, replaces on rerun", () => {
    const base = "# LifeOS\n\nbody\n";
    const once = upsertSection(base, section);
    expect(once.startsWith(base.trimEnd())).toBe(true);
    expect(once.split(SECTION_BEGIN).length).toBe(2);
    expect(upsertSection(once, section)).toBe(once);
    const newer = playbookSection({ root: ROOT, userData: `${ROOT}/user-data`, version: "9.0.0", commit: "a".repeat(40) });
    const updated = upsertSection(once, newer);
    expect(updated).toContain("9.0.0");
    expect(updated).not.toContain("8.761.0");
    expect(updated.split(SECTION_END).length).toBe(2);
  });

  test("imports CLAUDE.local.md on a line of its own", () => {
    expect(section).toMatch(/^@CLAUDE\.local\.md$/m);
  });

  test("stripSection gives back what upstream wrote", () => {
    const base = "# LifeOS\n\nbody";
    expect(stripSection(upsertSection(base + "\n", section))).toBe(base);
    expect(stripSection(base + "\n\n")).toBe(base);
  });

  test("never contains an ActivateImports pattern", () => {
    expect(section).not.toMatch(/^#\s*@|<!--\s*@/m);
  });

  test("bootstrap detection", () => {
    expect(isBootstrap(`${BOOTSTRAP_MARKER}\n# x`)).toBe(true);
    expect(isBootstrap(once())).toBe(false);
    function once() {
      return upsertSection("# LifeOS\n", section);
    }
  });
});

describe("coreServices", () => {
  test("keeps optIn:false rows as short names", () => {
    const json = JSON.stringify([
      { label: "com.lifeos.pulse", optIn: false },
      { label: "com.lifeos.modelsync", optIn: false },
      { label: "com.lifeos.wf.job", optIn: true },
      { title: "no label", optIn: false },
    ]);
    expect(coreServices(json)).toEqual(["modelsync", "pulse"]);
  });

  test("rejects non-arrays", () => {
    expect(() => coreServices("{}")).toThrow();
  });
});

describe("pickComponents", () => {
  test("drops components the release lacks", () => {
    expect(pickComponents(["agents", "gone"], ["agents", "helm"])).toEqual({ use: ["agents"], missing: ["gone"] });
  });
});

describe("pin", () => {
  const good = { repo: "danielmiessler/LifeOS", version: "8.761.0", tag: "v8.761.0", commit: "a".repeat(40), subpath: "LifeOS", pinned: "2026-10-28-03_10" };

  test("accepts a well-formed pin", () => {
    expect(validatePin(good)).toEqual(good);
  });

  test("rejects a tag that disagrees with the version, a short sha, a traversal subpath", () => {
    expect(() => validatePin({ ...good, tag: "v8.761.1" })).toThrow();
    expect(() => validatePin({ ...good, commit: "abc123" })).toThrow();
    expect(() => validatePin({ ...good, subpath: "../x" })).toThrow();
  });

  test("compareVersions is numeric", () => {
    expect(compareVersions("8.761.0", "8.99.0")).toBeGreaterThan(0);
    expect(compareVersions("7.40.4", "8.0.0")).toBeLessThan(0);
    expect(compareVersions("8.761.0", "8.761.0")).toBe(0);
  });
});

describe("diffSnapshots", () => {
  test("reports created, removed, modified and new directory entries", () => {
    const before = {
      "/h/a": { exists: false as const },
      "/h/b": { exists: true as const, kind: "file", mtime: 1, size: 1 },
      "/h/LaunchAgents": { exists: true as const, kind: "dir", mtime: 1, size: 1, tree: {} },
      "/h/c": { exists: true as const, kind: "file", mtime: 1, size: 1 },
    };
    const after = {
      "/h/a": { exists: true as const, kind: "file", mtime: 2, size: 1 },
      "/h/b": { exists: true as const, kind: "file", mtime: 2, size: 1 },
      "/h/LaunchAgents": { exists: true as const, kind: "dir", mtime: 2, size: 1, tree: { "com.lifeos.pulse.plist": "file 2 10" } },
      "/h/c": { exists: true as const, kind: "file", mtime: 1, size: 1 },
    };
    expect(diffSnapshots(before, after)).toEqual(["/h/a: created", "/h/b: modified", "/h/LaunchAgents: added com.lifeos.pulse.plist"]);
  });

  test("reports a file rewritten in place deep inside a watched directory", () => {
    const dir = (tree: Record<string, string>) => ({ exists: true as const, kind: "dir", mtime: 1, size: 1, tree });
    const before = { "/h/.claude/LIFEOS": dir({ TOOLS: "dir 0 0", "TOOLS/x.ts": "file 1 5" }) };
    const after = { "/h/.claude/LIFEOS": dir({ TOOLS: "dir 0 0", "TOOLS/x.ts": "file 2 7" }) };
    expect(diffSnapshots(before, after)).toEqual(["/h/.claude/LIFEOS: modified TOOLS/x.ts"]);
  });
});

describe("default data home", () => {
  test("its permission rules follow the data home into the playbook", () => {
    const src = `"Edit(~/.config/LIFEOS/USER/.git/hooks/**)" "$HOME/.config/LIFEOS" "${HOME}/.config/LIFEOS/USER" "~/.claude/x"`;
    const { text, count } = rebaseDefaultRoot(src, HOME, ROOT, `${ROOT}/user-data`);
    expect(count).toBe(4);
    expect(text).toBe(`"Edit(${ROOT}/user-data/USER/.git/hooks/**)" "${ROOT}/user-data" "${ROOT}/user-data/USER" "${ROOT}/x"`);
    expect(findDefaultRoot(text, HOME)).toEqual([]);
  });
  test("is reported while still spelled the default way, and left alone without a data home", () => {
    expect(findDefaultRoot("Edit(~/.config/LIFEOS/USER/CONFIG/settings.user.json)", HOME)).toHaveLength(1);
    expect(rebaseDefaultRoot("~/.config/LIFEOS", HOME, ROOT).count).toBe(0);
    expect(rebaseDefaultRoot("/x/.config/LIFEOS ~/.config/LIFEOSX", HOME, ROOT, "/d").count).toBe(0);
  });
});

describe("watch: playbook version", () => {
  test("restarts at pb.1 for a new upstream version, counts re-pins of the same one", async () => {
    const { nextPlaybookVersion } = await import("../watch");
    expect(nextPlaybookVersion("8.761.0+pb.1", "8.762.0")).toBe("8.762.0+pb.1");
    expect(nextPlaybookVersion("8.761.0+pb.1", "8.761.0")).toBe("8.761.0+pb.2");
    expect(nextPlaybookVersion("garbage", "8.761.0")).toBe("8.761.0+pb.1");
  });

  test("rewrites only the version line of .playbook", async () => {
    const { setManifestVersion } = await import("../watch");
    const src = 'name = "lifeos"\nversion = "8.761.0+pb.1"\n\n[update]\nmigrate = "playbook/bin/migrate"\n';
    expect(setManifestVersion(src, "8.762.0+pb.1")).toBe(src.replace("8.761.0+pb.1", "8.762.0+pb.1"));
    expect(() => setManifestVersion('name = "x"\n', "1.0.0+pb.1")).toThrow();
  });
});

describe("preserveKeys", () => {
  test("copies live values that override the system layer, once", () => {
    const live = { claudeMdExcludes: ["/home/user/.claude/**"], model: "opus", agent: "x", env: {} };
    const system = { model: "sonnet", agent: "x" };
    const layer: Record<string, unknown> = {};
    expect(preserveKeys(live, system, layer, ["claudeMdExcludes", "model", "agent"])).toEqual(["claudeMdExcludes", "model"]);
    expect(layer).toEqual({ claudeMdExcludes: ["/home/user/.claude/**"], model: "opus" });
    expect(preserveKeys(live, system, layer, ["claudeMdExcludes", "model", "agent"])).toEqual([]);
  });

  test("keeps a user-layer edit made since the last rebuild", () => {
    const snapshot = { model: "opus" };
    const live = { model: "opus" };
    const layer: Record<string, unknown> = { model: "sonnet" };
    expect(preserveKeys(live, {}, layer, ["model"], snapshot)).toEqual([]);
    expect(layer.model).toBe("sonnet");
  });

  test("still copies a live edit made since the last rebuild", () => {
    const layer: Record<string, unknown> = { model: "sonnet" };
    expect(preserveKeys({ model: "haiku" }, {}, layer, ["model"], { model: "opus" })).toEqual(["model"]);
    expect(layer.model).toBe("haiku");
  });
});

describe("writeTarget", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "wt-")));
  mkdirSync(join(dir, "root"));
  mkdirSync(join(dir, "outside"));
  test("a plain path and a missing file stay where they are", () => {
    writeFileSync(join(dir, "root", "a.json"), "{}");
    expect(writeTarget(join(dir, "root", "a.json"))).toBe(join(dir, "root", "a.json"));
    expect(writeTarget(join(dir, "root", "new.json"))).toBe(join(dir, "root", "new.json"));
  });
  test("follows a dangling link to where the write would create the file", () => {
    symlinkSync(join(dir, "outside", "settings.json"), join(dir, "root", "settings.json"));
    expect(writeTarget(join(dir, "root", "settings.json"))).toBe(join(dir, "outside", "settings.json"));
  });
  test("follows a link chain and a linked parent", () => {
    symlinkSync(join(dir, "outside"), join(dir, "root", "linked"));
    symlinkSync("linked/x.json", join(dir, "root", "chain.json"));
    expect(writeTarget(join(dir, "root", "chain.json"))).toBe(join(dir, "outside", "x.json"));
  });
});

describe("hookProblems", () => {
  const cmd = (c: string) => [{ hooks: [{ type: "command", command: c }] }];
  test("no hooks at all", () => expect(hookProblems({})).toEqual(["settings.json registers no hooks"]));
  test("hooks but no settings rebuild", () => expect(hookProblems({ hooks: { SessionStart: cmd("bun /r/hooks/Banner.ts") } })).toHaveLength(1));
  test("healthy", () => expect(hookProblems({ hooks: { SessionStart: cmd("bun /r/LIFEOS/TOOLS/SettingsBackport.ts; bun /r/LIFEOS/TOOLS/MergeSettings.ts") } })).toEqual([]));
});

describe("rebaseSettings", () => {
  test("rebases everything but cpb's claudeMdExcludes", () => {
    const settings = {
      claudeMdExcludes: [`${HOME}/.claude/**`],
      env: { LIFEOS_DIR: "$HOME/.claude/LIFEOS" },
      permissions: { allow: ["Edit(~/.claude/**)"] },
    };
    const { settings: out, count } = rebaseSettings(settings, HOME, ROOT);
    expect(count).toBe(2);
    expect(out.claudeMdExcludes).toEqual([`${HOME}/.claude/**`]);
    expect(out.env).toEqual({ LIFEOS_DIR: `${ROOT}/LIFEOS` });
    expect(out.permissions).toEqual({ allow: [`Edit(${ROOT}/**)`] });
    expect(settings.env.LIFEOS_DIR).toBe("$HOME/.claude/LIFEOS"); // input untouched
  });
});
