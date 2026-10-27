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
  playbookSection,
  rebaseDefaultRoot,
  upsertSection,
} from "../lib/patch";
import { compareVersions, validatePin } from "../lib/pin";
import { diffSnapshots } from "../lib/audit";

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
      "/h/LaunchAgents": { exists: true as const, kind: "dir", mtime: 1, size: 1, names: [] },
      "/h/c": { exists: true as const, kind: "file", mtime: 1, size: 1 },
    };
    const after = {
      "/h/a": { exists: true as const, kind: "file", mtime: 2, size: 1 },
      "/h/b": { exists: true as const, kind: "file", mtime: 2, size: 1 },
      "/h/LaunchAgents": { exists: true as const, kind: "dir", mtime: 2, size: 1, names: ["com.lifeos.pulse.plist"] },
      "/h/c": { exists: true as const, kind: "file", mtime: 1, size: 1 },
    };
    expect(diffSnapshots(before, after)).toEqual(["/h/a: created", "/h/b: modified", "/h/LaunchAgents: added com.lifeos.pulse.plist"]);
  });
});
