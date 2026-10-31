# Testing

The repository includes five test entry points under `playbook/tests/`:

- `bun test` (`patch.test.ts`): fast pure-function unit tests
- `playbook/tests/hook-smoke.ts`: fires every registered command hook in a converted playbook with synthetic Claude Code events
- `playbook/tests/e2e.sh`: sandboxed fresh conversion, hook smoke, settings and `CLAUDE.local.md` persistence, rerun, and cross-release upgrade
- `playbook/tests/cpb.sh`: `cpb CREATE PLAYBOOK`, `convert.ts`, `cpb update`, per-session `MergeSettings` rebuild, and `cpb DROP PLAYBOOK`
- `playbook/tests/journey.sh`: full first-time user path on a throwaway machine against its real `HOME`

Every pull request runs a full-history `gitleaks` scan, `bun test`, `e2e.sh` on `ubuntu-latest` and `macos-latest`, and `cpb.sh` on `ubuntu-latest` in `.github/workflows/ci.yml`.

## Unit Tests (`bun test`)

```bash
bun test
```

Runs `playbook/tests/patch.test.ts`. These tests cover the pure functions in `playbook/lib/patch.ts`, `playbook/lib/pin.ts`, `playbook/lib/audit.ts`, and `playbook/watch.ts`:

- `rebaseDefaultRoot`, `findDefaultRoot`, and `rebaseSettings` (including `claudeMdExcludes` exemption)
- `forceEnv` and `preserveKeys`
- `playbookSection`, `stripSection`, `upsertSection`, and `isBootstrap`
- `coreServices` and `pickComponents`
- `validatePin` and `compareVersions`
- `diffSnapshots`
- `nextPlaybookVersion` and `setManifestVersion`

`bun test` performs no network I/O and runs no upstream code. It is safe to run on any machine.

## Hook Smoke Test (`playbook/tests/hook-smoke.ts`)

```bash
bun playbook/tests/hook-smoke.ts --root /home/user/.claude-playbooks/lifeos
```

Fires every command hook registered in `<root>/settings.json` the way Claude Code does at runtime, without requiring a Claude Code login:

1. Exports `settings.env`, `CLAUDE_CONFIG_DIR=<root>`, and `CLAUDE_PROJECT_DIR=<root>/.lifeos-playbook/smoke-project` to each hook process.
2. Writes a realistic two-turn `transcript.jsonl` inside `<root>/.lifeos-playbook/smoke-project` (required because `Stop` and `SessionEnd` hooks parse the session transcript).
3. Sends a synthetic event JSON payload on stdin for each registered `type: "command"` hook (`SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SubagentStop`, `Notification`, `PreCompact`), deriving plausible tool calls from `PreToolUse` and `PostToolUse` matchers. Non-command hooks (such as HTTP hooks) are listed as `skip` because upstream designs them to fail open.
4. Fails if any command hook times out (`TIMEOUT`, capped at `min(hook.timeout ?? 60, 90)` seconds), exits `2` (`BLOCKED`, blocking an ordinary action), exits non-zero (`EXIT <code>`), or exits `0` with crash output on stderr (`STDERR`, matching `TypeError`, `ReferenceError`, `SyntaxError`, `Cannot find module`, `ENOENT`, `Unhandled`, `panic:`, or `Traceback`).
5. Fails if the registered command hook set is empty (`no command hooks are registered`) or if `SessionStart` lacks a `MergeSettings` registration (`SessionStart does not run the settings rebuild (MergeSettings)`).
6. Compares `/tmp` entries matching `/lifeos|pai-/i` before and after running hooks and prints a `note` for newly appearing entry names (upstream's `SessionStart` hook writes `/tmp/lifeos-session-start.txt`, shared by every LifeOS install on the machine). Changes to an entry that already existed are not reported.

Exit codes: `0` when every command hook exited `0` cleanly and expected registrations exist, `1` when a hook failed or an expected registration is missing, `2` on invalid usage.

## Converter End-to-End Suite (`playbook/tests/e2e.sh`)

```bash
bash playbook/tests/e2e.sh [--pin <file>] [--from-pin <file>] [--keep]
```

### Flags

| Flag | Description |
|---|---|
| `--pin <file>` | Pin file to test (default: `playbook/upstream.json`) |
| `--from-pin <file>` | Also test upgrading in place from `<file>` to `--pin` (skipped if both pins point to the same commit, since the rerun check already exercises the upgrade chain) |
| `--keep` | Keep the temporary sandbox directory (`mktemp -d -t lifeos-e2e-XXXXXX`) even when all checks pass (the sandbox is always kept if any check fails) |

### What `e2e.sh` Verifies

1. **Fresh install**: Stages a playbook root at `$HOME/.claude-playbooks/lifeos` from tracked files plus nonignored untracked working-tree files, runs `convert.ts`, and checks that `LIFEOS/VERSION` matches the pin, `.lifeos-playbook/state.json` has `problems.length === 0`, `LIFEOS/USER` resolves to `user-data/USER`, `CLAUDE.md` contains exactly one `lifeos-playbook:begin` marker and no `lifeos-playbook:bootstrap` marker, `.lifeos-playbook/staging` is removed, `user-data/USER/CUSTOMIZATIONS/SKILLS/*/Config.md` contains no `~/.claude` or `$HOME/.claude` paths, and nothing outside the playbook root (apart from package-manager and build caches) was written under `$HOME`.
2. **Hooks and config resolution**: Runs `playbook/tests/hook-smoke.ts --root "$ROOT"`, then plants a decoy `~/.claude/LIFEOS/USER/CONFIG/LIFEOS_CONFIG.toml` in a decoy `HOME` and verifies `lifeosUserDir()` in `LIFEOS/TOOLS/LifeosConfig.ts` resolves inside the playbook root rather than reading the default profile's config.
3. **User edits and idempotent rerun**: Adds a hand edit (`env.E2E_USER_SETTING = "kept"`) and enables `LIFEOS_StatusLine.sh` in `settings.json`, writes `CLAUDE.local.md`, runs the `SessionStart` rebuild (`SettingsBackport` + `MergeSettings`), and runs `convert.ts` a second time (which exercises the `upgrade` chain). Verifies `settings.json` and `CLAUDE.md` SHA-256 digests are unchanged, all conversion and outside-root assertions pass (including no statusline refresher job scheduled outside `<root>`), and after another `SessionStart` rebuild the hand edit, `statusLine`, `CLAUDE.local.md`, `@CLAUDE.local.md` import in `CLAUDE.md`, and `lifeosUserDir()` resolution all survive.
4. **`convert.ts --check`**: Runs the health check (pin, isolation audit, USER resolution, upstream Doctor with the playbook's settings env) and requires `healthy`, also when the playbook is reached through a symlinked path. Never run bare `Doctor.ts` against a playbook: without the playbook's env it misreports the USER links and suggests a relink that breaks isolation.
5. **Cross-release upgrade (when `--from-pin` differs from `--pin`)**: Creates a separate `$SANDBOX/home-upgrade`, converts `--from-pin`, writes `$UP/user-data/USER/e2e-marker.txt`, replaces `playbook/upstream.json` with `--pin`, makes a `settings.json` hand edit and runs the `SessionStart` rebuild, runs `convert.ts`, and verifies that `state.json` recorded `mode: "upgrade"`, `e2e-marker.txt` survived, all conversion assertions pass, every hook passes `hook-smoke.ts`, the hand edit survives the next rebuild, `lifeosUserDir()` resolves inside the playbook, and `convert.ts --check` is healthy.

## `cpb` Round-Trip Suite (`playbook/tests/cpb.sh`)

```bash
bash playbook/tests/cpb.sh [--keep]
```

Requires both `cpb` (v4+) and `bun` on `PATH`. Pass `--keep` to retain the temporary sandbox directory (`mktemp -d -t lifeos-cpb-XXXXXX`) when all checks pass.

### What `cpb.sh` Verifies

1. Creates a local git repository (`$SANDBOX/src`) from tracked files plus nonignored untracked working-tree files and runs `cpb --launcher-dir "$SANDBOX/bin" CREATE PLAYBOOK lifeos FROM "file://$SRC"`.
2. Verifies the playbook root contains `playbook/convert.ts`, the bootstrap `CLAUDE.md`, `.playbook` with `migrate = "playbook/bin/migrate"`, and `settings.json` with `claudeMdExcludes` containing `$HOME/.claude/**`.
3. Runs `bun "$ROOT/playbook/convert.ts"` and verifies exit `0` and intact `claudeMdExcludes`.
4. Bumps `.playbook` in `$SRC` to `+pb.99`, waits 61 seconds (so the minute-resolution `converted` timestamp advances), and runs `cpb update lifeos --yes`.
5. Verifies that `cpb update` pulled the source change, ran `playbook/bin/migrate`, re-ran `convert.ts` in `upgrade` mode with 0 audit problems, kept upstream's `CLAUDE.md` (not the bootstrap), and kept `claudeMdExcludes` and `env.LIFEOS_CONFIG_DIR`.
6. Extracts upstream's `SessionStart` `MergeSettings` hook command from `settings.json`, executes it, and verifies that `claudeMdExcludes`, `env.LIFEOS_CONFIG_DIR`, and rebased paths survive the per-session settings rebuild.
7. Runs `cpb DROP PLAYBOOK lifeos --yes` and verifies the playbook root and sandbox launcher are removed and that the directory-entry names beside the `cpb` binary are unchanged.

## Full User Journey Suite (`playbook/tests/journey.sh`)

```bash
bash playbook/tests/journey.sh --source <git url or file:// path> [--branch <b>] [--transcript <file>]
```

### Flags

| Flag | Description |
|---|---|
| `--source <url>` | Required git URL or `file://` path passed to `cpb CREATE PLAYBOOK` (exits `2` if omitted) |
| `--branch <b>` | Optional branch passed via `BRANCH <b>` |
| `--transcript <file>` | Path to write the full command/output transcript (default: `./journey-transcript.txt`) |

### What `journey.sh` Verifies

Exercises a new user's complete path on a throwaway machine as that machine's real user:

1. Installs `bun` (`~/.bun/bin`) and `cpb` (`~/.local/bin`, SHA-256 verified) if missing, and checks `git`.
2. Installs the playbook with `cpb CREATE PLAYBOOK`, runs `cpb SHOW PLAYBOOK`, and prints the bootstrap `CLAUDE.md`.
3. Runs `convert.ts --plan`. On Linux without `make`, verifies `--plan` prints the plan and exits `2` (`not ready`), verifies a real `convert.ts` run also exits `2` (`refused`), and installs `build-essential` via `apt-get`.
4. Runs the fresh conversion, verifies `state.json` and `LIFEOS/VERSION`, and runs `convert.ts --check` and `playbook/tests/hook-smoke.ts`.
5. Reruns `convert.ts` for idempotence.
6. Starts two conversions concurrently and verifies the second exits `2` while `.lifeos-playbook/convert.lock` is held and the first finishes with exit `0`.
7. Interrupts a running conversion process group with `SIGINT` (`setsid` + `kill -INT`) and verifies that another conversion then exits `0` and finishes audit-clean.
8. When `--source` is a `file://` checkout, bumps `.playbook` to `+pb.99`, waits 61 seconds, runs `cpb update lifeos --yes`, verifies `upgrade` mode, and re-runs `hook-smoke.ts`.
9. Uninstalls with `cpb DROP PLAYBOOK lifeos --yes` and verifies the playbook root and launcher are removed and no `~/.config/LIFEOS`, LifeOS systemd user units, or LifeOS crontab entries remain.

## Why End-to-End and Journey Suites Need a Disposable Machine

`e2e.sh`, `cpb.sh`, and `watch.ts --bump` set `HOME="$SANDBOX/home"` and `TMPDIR="$SANDBOX/tmp"`, but they execute upstream's real installer scripts (`install.sh`, `InstallAll.ts`, `bun install`, `node-gyp`). OS service managers such as macOS `launchctl` and systemd user instances are scoped to the OS user UID rather than `$HOME`, so an unisolated upstream change could register jobs before the post-install audit catches it. `journey.sh` additionally modifies the machine's real `HOME` (installing `bun` and `cpb`, creating and dropping `~/.claude-playbooks/lifeos`, and running `sudo apt-get` on Linux when `make` is absent). Run `e2e.sh`, `cpb.sh`, `journey.sh`, and `watch.ts --bump` only in a disposable VM, container, or CI runner, never on a workstation.

## Linux Build Requirements (`make` and `g++`)

On Linux, upstream's `DeployCore` step installs `node-pty` (a dependency of Pulse Desktop), which has no prebuilt Linux binary and compiles native C++ code via `node-gyp`. On Linux without `make` or `g++` on `PATH`, `convert.ts --plan` prints the plan and exits `2` with `not ready: ...`, and a real `convert.ts` run refuses before modifying files with exit `2` (`sudo apt install build-essential` on Debian/Ubuntu).
