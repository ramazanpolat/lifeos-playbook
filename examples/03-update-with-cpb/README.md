# 03: Update with `cpb`

When `upstream-watch` merges a new pin into `lifeos-playbook`, `cpb update` pulls the new commit (keeping `CLAUDE.md` across the pull so the bootstrap file is not restored) and runs `playbook/bin/migrate` to upgrade LifeOS in place. During the upgrade, upstream replaces `CLAUDE.md` from its template (saving the previous file in `.lifeos-overlay-backups/`), and `convert.ts` re-inserts the playbook section importing `CLAUDE.local.md`.

## Command

```bash
cpb update lifeos --yes
```

## What `cpb update` Executes

`cpb` reads `[update]` from `.playbook`:

```toml
[update]
preserve = ["CLAUDE.md"]
migrate = "playbook/bin/migrate"
```

After updating the tracked files in `/home/user/.claude-playbooks/lifeos`, `cpb` invokes `playbook/bin/migrate <from-version> <to-version> <install-dir>`, which runs:

```bash
bun /home/user/.claude-playbooks/lifeos/playbook/convert.ts \
  --root /home/user/.claude-playbooks/lifeos \
  --migrate-from 8.761.0+pb.1 \
  --migrate-to 8.762.0+pb.1
```

## Expected Output Shape

```text
[convert] root      /home/user/.claude-playbooks/lifeos
[convert] release   danielmiessler/LifeOS 8.762.0 @ 1a2b3c4d5e6f
[convert] mode      upgrade (installed 8.761.0)
[convert] user data /home/user/.claude-playbooks/lifeos/user-data
[convert] source    fetch github.com/danielmiessler/LifeOS 1a2b3c4d5e6f7890abcdef1234567890abcdef12
[convert] cpb update 8.761.0+pb.1 -> 8.762.0+pb.1
[convert] fetching the pinned commit
[convert] settings backport before upgrade: <backport summary>
[convert] placing the skill (release install.sh)
...
[convert] installing: components tooltips,spinnerverbs,agents,commands,workflows; declining services <comma-separated core services returned by the candidate release>
[convert] InstallAll (upgrade): MigrateMark ok, OverlaySystem ok, InstallHooks ok, ScaffoldUser ok, LinkUser ok, RefreshStatusline ok, DeployComponents ok, ActivateImports ok, RenderIdentity ok, Migrate ok, CoreServices skipped
[convert] settings.json: rebased <count> default-profile path(s)
[convert] settings.system.json: rebased <count> default-profile path(s)
[convert] USER tree: rebased default-profile paths in <count> file(s): <comma-separated changed paths>
[convert] done: LifeOS 8.762.0 is installed in /home/user/.claude-playbooks/lifeos
```

The `settings.json`, `settings.system.json`, and `USER tree` rebase lines print only when their `<count>` is positive; any of them may be absent when no paths require rebasing. In addition, `[convert] statusline: set aside during the upgrade so upstream schedules no machine-wide refresher job` prints before `InstallAll (upgrade)` when `LIFEOS_StatusLine.sh` is configured in `settings.json`, and `[convert] CLAUDE.md now holds upstream's template; the previous one is in .lifeos-overlay-backups/. Keep personal instructions in CLAUDE.local.md, which updates never touch` prints when upstream's `CLAUDE.md` template changed.

Exit code: `0`.
