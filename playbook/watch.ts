#!/usr/bin/env bun
/**
 * watch -- notice a new upstream LifeOS release and, once it converts cleanly, pin it.
 *
 *   bun playbook/watch.ts                         # report pinned vs latest; exit 0 current, 10 newer
 *   bun playbook/watch.ts --candidate-out <file>  # same, and write a newer release as a candidate pin
 *   bun playbook/watch.ts --apply <file>          # make a tested candidate the pin; bump .playbook version
 *   bun playbook/watch.ts --bump                  # all three locally: detect, run e2e, apply
 *
 * A release counts as new when its version is higher than the pin, or when its tag now
 * points at a different commit (upstream force-moves release tags). Git and PR work is
 * left to the caller (.github/workflows/upstream-watch.yml); this script only edits files.
 *
 * Exit: 0 nothing to do, 10 newer release found, 11 pin applied, 12 e2e failed, 1 error.
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
  const next = readPin(candidate);
  writePin(pinFile, next);
  const text = readFileSync(manifest, "utf8");
  const cur = text.match(/^version\s*=\s*"(.*)"$/m)?.[1] ?? "";
  const version = nextPlaybookVersion(cur, next.version);
  writeFileSync(manifest, setManifestVersion(text, version));
  say(`pinned ${next.version}@${next.commit.slice(0, 12)}; playbook version ${cur} -> ${version}`);
  return version;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const opt = (f: string) => {
    const i = args.indexOf(f);
    if (i < 0) return undefined;
    if (!args[i + 1]) throw new Error(`${f} needs a file`);
    return args[i + 1];
  };

  const applyFile = opt("--apply");
  if (applyFile) {
    apply(applyFile);
    return 11;
  }

  const latest = await detect();
  if (!latest) return 0;
  const out = opt("--candidate-out");
  if (out) writePin(out, latest);
  if (!args.includes("--bump")) return 10;

  const candidate = out ?? join(here, `.candidate-${latest.version}.json`);
  if (!out) writePin(candidate, latest);
  try {
    if (!e2e(candidate)) {
      say("e2e failed; pin unchanged");
      return 12;
    }
    apply(candidate);
    return 11;
  } finally {
    if (!out) rmSync(candidate, { force: true });
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
