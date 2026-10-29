#!/usr/bin/env bun
/**
 * watch -- notice a new upstream LifeOS release and, once it converts cleanly, pin it.
 *
 *   bun playbook/watch.ts                         # report pinned vs latest; exit 0 current, 10 newer
 *   bun playbook/watch.ts --candidate-out <file>  # same, and write a newer release as a candidate pin
 *   bun playbook/watch.ts --bump                  # detect, then run the e2e suite on this machine's OS
 *                                                 # (a disposable VM, container or CI runner: it runs
 *                                                 # upstream's installer);
 *                                                 # keeps the candidate file, does not pin
 *   bun playbook/watch.ts --apply <file>          # make a candidate the pin; bump .playbook version
 *
 * Pinning needs the e2e suite green on Linux AND macOS for that exact candidate: the
 * upstream-watch workflow runs --apply only after both matrix jobs pass. A local --bump
 * covers one OS, so it never pins; --apply by hand is an override for when both were run.
 *
 * A release counts as new when its version is higher than the pin, or when its tag now
 * points at a different commit (upstream force-moves release tags). Git and PR work is
 * left to the caller (.github/workflows/upstream-watch.yml); this script only edits files.
 *
 * Exit: 0 nothing to do, 10 newer release found (with --bump: and it passed e2e here), 11 pin
 *       applied, 12 e2e failed, 1 error.
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { compareVersions, readPin, resolveLatest, writePin, type Pin } from "./lib/pin";
import { run } from "./lib/sh";

const here = import.meta.dir;
const pinFile = join(here, "upstream.json");
const manifest = join(dirname(here), ".playbook");
const say = (m: string) => console.log(`[watch] ${m}`);

/** `<upstream>+pb.<n>`: n restarts at 1 for a new upstream version and counts re-pins of the same one. */
export function nextPlaybookVersion(current: string, upstream: string): string {
  const m = current.match(/^(\d+\.\d+\.\d+)\+pb\.(\d+)$/);
  if (m && m[1] === upstream) return `${upstream}+pb.${Number(m[2]) + 1}`;
  return `${upstream}+pb.1`;
}

export function setManifestVersion(text: string, version: string): string {
  if (!/^version\s*=\s*".*"$/m.test(text)) throw new Error(".playbook has no version line");
  return text.replace(/^version\s*=\s*".*"$/m, `version = "${version}"`);
}

/** The newest release when it should replace the pin, else null. */
async function detect(): Promise<Pin | null> {
  const pin = readPin(pinFile);
  const latest = { ...(await resolveLatest(pin.repo, pin.subpath)), subpath: pin.subpath };
  const cmp = compareVersions(latest.version, pin.version);
  const short = (p: Pin) => `${p.version}@${p.commit.slice(0, 12)}`;
  if (cmp < 0) {
    say(`latest release ${short(latest)} is older than the pin ${short(pin)}; leaving the pin alone`);
    return null;
  }
  if (cmp === 0 && latest.commit === pin.commit) {
    say(`up to date: ${short(pin)}`);
    return null;
  }
  say(`${cmp === 0 ? "release tag moved" : "new release"}: ${short(pin)} -> ${short(latest)}`);
  return latest;
}

function e2e(candidate: string): boolean {
  say("running the e2e suite against the candidate (fresh install, rerun, upgrade from the pin)");
  return run("bash", [join(here, "tests/e2e.sh"), "--pin", candidate, "--from-pin", pinFile], { allowFail: true }).code === 0;
}

function apply(candidate: string): string {
  // Validate both files before writing either, so a failure never leaves them disagreeing.
  const next = readPin(candidate);
  const text = readFileSync(manifest, "utf8");
  const cur = text.match(/^version\s*=\s*"(.*)"$/m)?.[1] ?? "";
  const version = nextPlaybookVersion(cur, next.version);
  const newManifest = setManifestVersion(text, version);
  writePin(pinFile, next);
  writeFileSync(manifest, newManifest);
  say(`pinned ${next.version}@${next.commit.slice(0, 12)}; playbook version ${cur} -> ${version}`);
  return version;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const usage = `usage: bun ${import.meta.path} [--candidate-out <file>] [--bump] | --apply <file>`;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--bump") continue;
    if (args[i] === "--apply" || args[i] === "--candidate-out") {
      if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`${args[i]} needs a file. ${usage}`);
      i++;
      continue;
    }
    throw new Error(`unknown argument: ${args[i]}. ${usage}`);
  }
  const opt = (f: string) => {
    const i = args.indexOf(f);
    return i < 0 ? undefined : args[i + 1];
  };

  const applyFile = opt("--apply");
  if (applyFile) {
    apply(applyFile);
    return 11;
  }

  const latest = await detect();
  if (!latest) return 0;
  const out = opt("--candidate-out");
  if (out) {
    writePin(out, latest);
    say(`candidate written to ${out}; pin unchanged`);
  }
  if (!args.includes("--bump")) {
    say("next: the upstream-watch workflow tests it on Linux and macOS and pins it; locally, --bump tests it on this OS");
    return 10;
  }

  const candidate = out ?? join(here, `.candidate-${latest.version}.json`);
  if (!out) writePin(candidate, latest);
  if (!e2e(candidate)) {
    say(`e2e failed on ${process.platform}; pin unchanged (exit 12). The failed checks and the kept sandbox are listed above`);
    if (!out) rmSync(candidate, { force: true });
    return 12;
  }
  say(`e2e passed on ${process.platform}; pin unchanged. Pinning needs both OSes: the upstream-watch workflow does it,`);
  say(`or run the suite on the other OS too, then: bun playbook/watch.ts --apply ${candidate}`);
  return 10;
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
