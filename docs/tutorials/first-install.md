# First Install

This tutorial walks through creating the `lifeos` playbook with `cpb`, inspecting the conversion plan, converting the pinned upstream LifeOS release, and running the initial setup interview.

## Prerequisites

- `cpb` v4+ on `PATH`
- `bun` 1.2+ on `PATH`
- `git` on `PATH`
- On Linux: `make` and `g++` on `PATH` (for example, `apt install build-essential`), because upstream's installer compiles `node-pty` from source via `node-gyp`

## 1. Create the Playbook

Clone the converter repository into a new playbook root managed by `cpb`:

```bash
cpb CREATE PLAYBOOK lifeos FROM https://github.com/ramazanpolat/lifeos-playbook
```

This creates `/home/user/.claude-playbooks/lifeos` and registers the `lifeos` launcher. At this stage, LifeOS itself is not installed yet; the directory contains the converter (`playbook/convert.ts`), the upstream pin (`playbook/upstream.json`), `.playbook`, a bootstrap `CLAUDE.md`, and `settings.json` with `claudeMdExcludes` excluding `/home/user/.claude/**`.

## 2. Inspect the Plan

Run the converter with `--plan` to run preflight checks, print what the conversion will do, and verify conversion prerequisites without modifying any files:

```bash
bun ~/.claude-playbooks/lifeos/playbook/convert.ts --plan
```

Expected output (exit code `0`):

```text
[convert] root      /home/user/.claude-playbooks/lifeos
[convert] release   danielmiessler/LifeOS 8.761.0 @ fb9aef4640a7
[convert] mode      fresh
[convert] user data /home/user/.claude-playbooks/lifeos/user-data
[convert] source    fetch github.com/danielmiessler/LifeOS fb9aef4640a73feae4c2e6483b26f58491ce2665
[convert] plan only: components tooltips,spinnerverbs,agents,commands,workflows (minus any the release lacks); all core services declined
[convert] ready: run the same command without --plan to convert
```

On Linux, if `make` or `g++` is missing, `--plan` prints `[convert] not ready: ...` instead of `ready` and exits `2`.

## 3. Convert the Playbook

Run the converter without `--plan`:

```bash
bun ~/.claude-playbooks/lifeos/playbook/convert.ts
```

The converter performs seven steps:

1. Fetches the exact commit pinned in `playbook/upstream.json` into `.lifeos-playbook/staging/<commit>` and verifies `HEAD`.
2. Pre-seeds `settings.json` with `env.LIFEOS_CONFIG_DIR` (`/home/user/.claude-playbooks/lifeos/user-data`), `env.LIFEOS_DIR` (`/home/user/.claude-playbooks/lifeos/LIFEOS`), and `env.LIFEOS_CONFIG_PATH` (`/home/user/.claude-playbooks/lifeos/user-data/USER/CONFIG/LIFEOS_CONFIG.toml`), moves the bootstrap `CLAUDE.md` to `.lifeos-playbook/bootstrap-CLAUDE.md`, and initializes `.git` if absent.
3. Runs upstream's `install/install.sh` with shell aliases and auto-launch disabled (`LIFEOS_SKIP_ALIAS=1`, `LIFEOS_NO_LAUNCH=1`, `LIFEOS_AUTO_INSTALL_BUN=0`).
4. Runs upstream's `Tools/InstallAll.ts` with `--config-root` set to the playbook root, all core services declined, and `--components` restricted to the allow-list (`tooltips,spinnerverbs,agents,commands,workflows`).
5. Rebases default-profile paths (`~/.claude`, `$HOME/.claude`, `${HOME}/.claude`, `/home/user/.claude`) in `settings.json`, `settings.system.json` (when present), and eligible text files under `user-data/USER`, pins `LIFEOS_CONFIG_DIR`, `LIFEOS_DIR`, and `LIFEOS_CONFIG_PATH` across settings layers, and copies `claudeMdExcludes`, `model`, and `agent` into `user-data/USER/CONFIG/settings.user.json` when their values differ from the system layer.
6. Appends the `<!-- lifeos-playbook:begin -->` section (which imports `@CLAUDE.local.md`) to upstream's `CLAUDE.md`, prunes older skill backups, and writes `LIFEOS/MEMORY/STATE/settings-merge-snapshot.json` so subsequent hand edits to `settings.json` are backported on session start.
7. Audits the playbook root and watched paths in `/home/user`, writes `.lifeos-playbook/state.json`, and removes the staging directory.

When the run finishes cleanly, it exits `0` and prints:

```text
[convert] done: LifeOS 8.761.0 is installed in /home/user/.claude-playbooks/lifeos; start the playbook and run /LifeOS setup to begin the interview
```

## 4. Launch and Run Setup

Start Claude Code with the playbook launcher:

```bash
lifeos
```

If you had already started a `lifeos` session before running `convert.ts`, exit and restart it so the new `settings.json`, `CLAUDE.md`, and hooks load.

Inside the session, start the LifeOS onboarding interview:

```text
/LifeOS setup
```

LifeOS's `USER` tree and memory live under `/home/user/.claude-playbooks/lifeos/user-data/USER` (linked from `LIFEOS/USER` and `LIFEOS/MEMORY`). Other configuration and state, including root settings (`settings.json`), `.env`, and personal instructions (`CLAUDE.local.md`), live elsewhere in the playbook root.
