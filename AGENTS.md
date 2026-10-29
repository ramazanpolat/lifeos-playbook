# AGENTS.md

Instructions for coding agents installing, updating, or maintaining `lifeos-playbook`.

## Prerequisites

Verify these tools are available on `PATH` before running any playbook commands:

- `cpb` v4+ (`cpb --version`)
- `bun` 1.2+ (`bun --version`)
- `git` (`git --version`)
- On Linux: `make` and `g++` (`command -v make && command -v g++`), required because upstream's installer compiles `node-pty` with `node-gyp`

## Exact Commands

### Fresh Install and Conversion

```bash
cpb CREATE PLAYBOOK lifeos FROM https://github.com/ramazanpolat/lifeos-playbook
bun ~/.claude-playbooks/lifeos/playbook/convert.ts --plan
bun ~/.claude-playbooks/lifeos/playbook/convert.ts
```

If converting inside a session where `CLAUDE_CONFIG_DIR` is already set to the playbook root:

```bash
bun "$CLAUDE_CONFIG_DIR/playbook/convert.ts" --plan
bun "$CLAUDE_CONFIG_DIR/playbook/convert.ts"
```

After a fresh conversion, instruct the user to start (or restart) the `lifeos` session and run `/LifeOS setup`.

### Updating an Existing Playbook

```bash
cpb update lifeos --yes
```

`cpb update` preserves `<root>/CLAUDE.md` during the source pull (via `.playbook` `preserve = ["CLAUDE.md"]`) and runs `playbook/bin/migrate`, which executes `playbook/convert.ts --root <dir> --migrate-from <old> --migrate-to <new>` in `upgrade` mode. During the upgrade, upstream replaces `<root>/CLAUDE.md` with its release template (backing up the previous file in `<root>/.lifeos-overlay-backups/<timestamp>/CLAUDE.md.bak`) and `convert.ts` re-inserts the playbook section, which imports `@CLAUDE.local.md`. Put personal instructions in `<root>/CLAUDE.local.md` (never overwritten), and put persistent settings overrides in `<root>/user-data/USER/CONFIG/settings.user.json` (hand edits to `<root>/settings.json` are also backported via `SettingsBackport.ts` and `LIFEOS/MEMORY/STATE/settings-merge-snapshot.json`).

### Offline Conversion from a Local Upstream Checkout

```bash
bun ~/.claude-playbooks/lifeos/playbook/convert.ts --src /home/user/src/LifeOS
```

Add `--unverified-src` only when the local directory is not at the exact commit in `playbook/upstream.json`.

### Unit Tests (Safe on Any Machine)

```bash
bun test
```

## Converter Flags and Exit Codes

`playbook/convert.ts` flags:

- `--root <dir>`: playbook root (default: parent directory of `playbook/`)
- `--pin <file>`: pin file (default: `playbook/upstream.json`)
- `--src <dir>`: local upstream checkout at the pinned commit instead of fetching from GitHub
- `--unverified-src`: accept `--src` without checking its `git rev-parse HEAD` commit
- `--allow-downgrade`: allow converting a pin version lower than `LIFEOS/VERSION`
- `--keep-staging`: keep `.lifeos-playbook/staging/<commit>` after a successful run
- `--plan`: run preflight, print the plan without modifying files, and check conversion prerequisites (prints `ready` and exits `0`, or prints `not ready: ...` and exits `2`)
- `--migrate-from <v>` / `--migrate-to <v>`: passed by `playbook/bin/migrate` during `cpb update`

`playbook/convert.ts` exit codes:

- `0`: converted and audit-clean (with `--plan`: ready; or `--help`)
- `1`: failed during runtime checks (such as an unsuccessful `git --version` check), fetch, verification, install, or transforms
- `2`: refused during preflight, CLI parsing, missing conversion prerequisites (`make`/`g++` on Linux, including `--plan` when not ready), downgrade check, or active `.lifeos-playbook/convert.lock`
- `3`: converted, but the post-install audit recorded isolation problems in `.lifeos-playbook/state.json`

## Verifying Success from `.lifeos-playbook/state.json`

After running `convert.ts` or `cpb update`, verify the installation by checking `<root>/.lifeos-playbook/state.json`:

```bash
bun -e '
  const fs = require("node:fs");
  const root = "/home/user/.claude-playbooks/lifeos";
  const pin = JSON.parse(fs.readFileSync(`${root}/playbook/upstream.json`, "utf8"));
  const state = JSON.parse(fs.readFileSync(`${root}/.lifeos-playbook/state.json`, "utf8"));
  const version = fs.readFileSync(`${root}/LIFEOS/VERSION`, "utf8").trim();
  if (state.version !== pin.version || state.commit !== pin.commit) process.exit(1);
  if (version !== pin.version) process.exit(1);
  if (!Array.isArray(state.problems) || state.problems.length !== 0) process.exit(1);
  console.log("verified:", state.version, state.mode);
'
```

A healthy conversion satisfies all of the following:

- `convert.ts` exited with code `0`.
- `<root>/.lifeos-playbook/state.json` exists and has `"problems": []`.
- `state.version` and `state.commit` match `<root>/playbook/upstream.json`.
- `<root>/LIFEOS/VERSION` matches `state.version`.
- `<root>/LIFEOS/USER` resolves inside `<root>/user-data/USER`.
- `<root>/settings.json` pins `env.LIFEOS_CONFIG_DIR`, `env.LIFEOS_DIR`, and `env.LIFEOS_CONFIG_PATH` (`<root>/user-data/USER/CONFIG/LIFEOS_CONFIG.toml`), and that TOML file exists.

## What Never to Do

- **Never run `playbook/tests/e2e.sh`, `playbook/tests/cpb.sh`, `playbook/tests/journey.sh`, or `bun playbook/watch.ts --bump` on a workstation.** `e2e.sh`, `cpb.sh`, and `watch.ts --bump` execute upstream's real installer under a temporary `HOME`, and `journey.sh` modifies the machine's real `HOME`; run them only on a disposable VM, container, or CI runner. On a workstation, run only `bun test` and `convert.ts --plan` (or `convert.ts` and `playbook/tests/hook-smoke.ts` against an isolated playbook root).
- **Never convert `~/.claude`.** The default Claude Code profile must remain untouched. `convert.ts` explicitly refuses to run when `--root` resolves to `~/.claude`.
- **Never push to the upstream repository (`danielmiessler/LifeOS`).** This repository only reads from `danielmiessler/LifeOS` and pins tested commits in `playbook/upstream.json`.
