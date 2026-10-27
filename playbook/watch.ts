#!/usr/bin/env bun
/**
 * watch -- notice a new upstream LifeOS release and, when it converts cleanly, pin it.
 *
 *   bun playbook/watch.ts            # report pinned vs latest; exit 0 current, 10 newer release
 *   bun playbook/watch.ts --bump     # newer release: run the e2e suite against it, then rewrite
 *                                    # playbook/upstream.json and the .playbook version
 *
 * Flags: --skip-e2e     bump without the e2e suite (manual use only; the CI watcher never passes it)
 *        --json         one JSON line on stdout instead of prose
 *
 * A release counts as new when its version is higher than the pin, or when its tag now
 * points at a different commit (upstream force-moves release tags). Git and PR work is
 * left to the caller (.github/workflows/upstream-watch.yml); this script only edits files.
 *
 * Exit: 0 nothing to do, 10 newer release found (report mode), 11 bumped, 1 failed, 12 e2e failed.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { compareVersions, readPin, resolveLatest, writePin, type Pin } from "./lib/pin";
import { run } from "./lib/sh";

const here = import.meta.dir;
const repoRoot = dirname(here);
const pinFile = join(here, "upstream.json");
const manifest = join(repoRoot, ".playbook");

/** `<upstream>+pb.<n>`: n restarts at 1 for a new upstream version and counts re-pins of the same one. */
export function nextPlaybookVersion(current: string, upstream: string): string {
  const m = current.match(/^(\d+\.\d+\.\d+)\+pb\.(\d+)$/);
  if (m && m[1] === upstream) return `${upstream}+pb.${Number(m[2]) + 1}`;
  return `${upstream}+pb.1`;
}

function setManifestVersion(text: string, version: string): string {
  if (!/^version\s*=\s*".*"$/m.test(text)) throw new Error(".playbook has no version line");
  return text.replace(/^version\s*=\s*".*"$/m, `version = "${version}"`);
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const bump = args.includes("--bump");
  const skipE2e = args.includes("--skip-e2e");
  const json = args.includes("--json");
  const pin = readPin(pinFile);
  const latest = await resolveLatest(pin.repo, pin.subpath);
  const cmp = compareVersions(latest.version, pin.version);
  const moved = cmp === 0 && latest.commit !== pin.commit;
  const newer = cmp > 0 || moved;
  const report = { pinned: `${pin.version}@${pin.commit.slice(0, 12)}`, latest: `${latest.version}@${latest.commit.slice(0, 12)}`, newer, moved };
  const say = (m: string) => (json ? undefined : console.log(`[watch] ${m}`));

  if (cmp < 0) say(`latest release ${latest.version} is older than the pin ${pin.version}; leaving the pin alone`);
  if (!newer) {
    say(`up to date: ${report.pinned}`);
    if (json) console.log(JSON.stringify({ ...report, action: "none" }));
    return 0;
  }
  say(`${moved ? "release tag moved" : "new release"}: ${report.pinned} -> ${report.latest}`);
  if (!bump) {
    if (json) console.log(JSON.stringify({ ...report, action: "report" }));
    return 10;
  }

  const candidate = join(here, `.candidate-${latest.version}.json`);
  writePin(candidate, { ...latest, subpath: pin.subpath } satisfies Pin);
  try {
    if (!skipE2e) {
      say("running the e2e suite against the candidate (fresh install, rerun, upgrade from the pin)");
      const r = run("bash", [join(here, "tests/e2e.sh"), "--pin", candidate, "--from-pin", pinFile], { allowFail: true });
      if (r.code !== 0) {
        say(`e2e failed (exit ${r.code}); pin unchanged`);
        if (json) console.log(JSON.stringify({ ...report, action: "e2e-failed" }));
        return 12;
      }
    }
    writePin(pinFile, { ...latest, subpath: pin.subpath });
    const text = readFileSync(manifest, "utf8");
    const cur = text.match(/^version\s*=\s*"(.*)"$/m)?.[1] ?? "";
    const next = nextPlaybookVersion(cur, latest.version);
    writeFileSync(manifest, setManifestVersion(text, next));
    say(`pinned ${latest.version}@${latest.commit.slice(0, 12)}; playbook version ${cur} -> ${next}`);
    if (json) console.log(JSON.stringify({ ...report, action: "bumped", version: next }));
    return 11;
  } finally {
    run("rm", ["-f", candidate]);
  }
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`[watch] failed: ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    },
  );
}
