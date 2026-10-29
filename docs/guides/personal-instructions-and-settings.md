# Personal Instructions and Settings

A converted `lifeos` playbook runs upstream's installer on updates and upstream's `SessionStart` settings merger at session startup. Understanding which files those steps overwrite and which files they import or backport ensures personal instructions and configuration changes persist across sessions and updates.

## Personal Instructions (`CLAUDE.local.md`)

Put personal Claude Code instructions in `<root>/CLAUDE.local.md` (for example, `/home/user/.claude-playbooks/lifeos/CLAUDE.local.md`), beside `<root>/CLAUDE.md`.

```bash
cat <<'EOF' > /home/user/.claude-playbooks/lifeos/CLAUDE.local.md
## Personal Notes

- Prefer concise responses.
EOF
```

Why `CLAUDE.local.md` instead of `CLAUDE.md`:

1. During `cpb update`, `.playbook` sets `preserve = ["CLAUDE.md"]` so `cpb` does not overwrite the converted `CLAUDE.md` with the repository's bootstrap `CLAUDE.md`.
2. Next, `playbook/bin/migrate` runs `playbook/convert.ts` in `upgrade` mode. Upstream's `OverlaySystem` step backs up `<root>/CLAUDE.md` to `<root>/.lifeos-overlay-backups/<timestamp>/CLAUDE.md.bak` and replaces `<root>/CLAUDE.md` with the new release's template.
3. Step 6 of `convert.ts` appends (or replaces via `upsertSection`) the bounded `<!-- lifeos-playbook:begin --> ... <!-- lifeos-playbook:end -->` section at the bottom of `CLAUDE.md`. That section ends with `@CLAUDE.local.md` on its own line (`playbook/lib/patch.ts`), so Claude Code imports `CLAUDE.local.md` automatically.
4. Neither `cpb update`, upstream's installer, nor `convert.ts` ever modifies or deletes `CLAUDE.local.md`.

When an upgrade changes the body of `CLAUDE.md` outside the managed playbook section, `convert.ts` records `"claudeMdReplaced": true` in `<root>/.lifeos-playbook/state.json` and logs:

```text
[convert] CLAUDE.md now holds upstream's template; the previous one is in .lifeos-overlay-backups/. Keep personal instructions in CLAUDE.local.md, which updates never touch
```

If you previously added notes directly to `CLAUDE.md`, copy them out of `<root>/.lifeos-overlay-backups/<timestamp>/CLAUDE.md.bak` into `<root>/CLAUDE.local.md`.

## How Settings Edits Survive

Upstream manages `<root>/settings.json` through a two-layer merge on `SessionStart` (`SettingsBackport.ts` followed by `MergeSettings.ts`):

- **System layer**: `<root>/settings.system.json` (shipped and refreshed by upstream).
- **User layer**: `<root>/user-data/USER/CONFIG/settings.user.json` (your overrides, winning key by key over the system layer).

When both layer files exist, `MergeSettings` rebuilds `<root>/settings.json` from `settings.system.json` plus `settings.user.json`, while preserving qualifying installer-owned keys (`hooks`, `statusLine`, `spinnerVerbs`, `spinnerTipsOverride`) from the existing `settings.json` when neither layer defines them. When either layer file is missing, `MergeSettings` reports that there is nothing to merge and leaves `settings.json` alone.

### Editing `settings.user.json` Directly

Overrides in `<root>/user-data/USER/CONFIG/settings.user.json` normally take precedence in every `MergeSettings` rebuild. Two exceptions come from upstream: an empty permission array keeps the system rules, and invalid permission rules are removed. During conversion, `convert.ts` updates `settings.user.json` in place:

- Rebases any default-profile (`~/.claude`) paths to `<root>` (leaving `claudeMdExcludes` untouched).
- Forces `env.LIFEOS_CONFIG_DIR`, `env.LIFEOS_DIR`, and `env.LIFEOS_CONFIG_PATH` to stay inside `<root>`.
- Copies `cpb` keys (`claudeMdExcludes`, `model`, `agent`) from `<root>/settings.json` into `settings.user.json` whenever their value differs from the system layer (`preserveKeys`). Values equal to the system default are not copied, so a later upstream default change still applies; an entry already in the user layer is left as it is.

### Hand-Editing `settings.json` (Backport and Merge Snapshot)

Hand edits made directly to `<root>/settings.json` are carried into the user layer by upstream's `SettingsBackport`, which needs both settings layers and a merge snapshot (`<root>/LIFEOS/MEMORY/STATE/settings-merge-snapshot.json`). The converter provides all three:

0. **System layer from the first conversion**: upstream creates `settings.system.json` only on upgrade, and `SettingsBackport` fails without it. `convert.ts` establishes it (from the release's template, rebased) on a fresh install too.

1. **Snapshot written after every conversion**: At the end of `convert.ts`, before running the audit, the converter writes `LIFEOS/MEMORY/STATE/settings-merge-snapshot.json` equal to the converted `settings.json`. Any hand edit made to `settings.json` afterward differs from that snapshot, so upstream's `SessionStart` `SettingsBackport.ts` detects the drift and carries it into `user-data/USER/CONFIG/settings.user.json` before `MergeSettings.ts` rebuilds `settings.json`. (Without a snapshot, `SettingsBackport` skips and the first rebuild would drop those edits.) Deleting a key the system layer supplies is not preserved automatically, and `convert.ts` continues if the pre-upgrade backport fails (it logs the result).
2. **Backport run before every upgrade**: If you edit `settings.json` and run `cpb update` (or `convert.ts`) before starting a new Claude Code session, `convert.ts` checks for `LIFEOS/MEMORY/STATE/settings-merge-snapshot.json` and runs `bun <root>/LIFEOS/TOOLS/SettingsBackport.ts` before invoking upstream's installer, folding your hand edits into `settings.user.json` first.

Do not change `env.LIFEOS_CONFIG_DIR`, `env.LIFEOS_DIR`, or `env.LIFEOS_CONFIG_PATH` to paths outside `<root>`; `convert.ts` forces all three on every conversion and `auditInside` flags any mismatch with exit code `3`.

If you configure LifeOS's shipped statusline (`LIFEOS_StatusLine.sh`) in `settings.json`, `convert.ts` temporarily sets `statusLine` aside while `InstallAll.ts` runs during an upgrade so upstream's `RefreshStatusline` step schedules no machine-wide launchd job (`com.lifeos.workflows-dispatcher`), then restores `statusLine` afterward.

## What Upgrades Replace vs Keep

| Path (relative to `<root>`) | Behavior on `cpb update` / Upgrade Conversion |
|---|---|
| `CLAUDE.local.md` | Untouched; imported by `@CLAUDE.local.md` at the end of `CLAUDE.md`. |
| `CLAUDE.md` | Replaced from upstream's release template (previous file backed up in `.lifeos-overlay-backups/<timestamp>/CLAUDE.md.bak`), then the `<!-- lifeos-playbook:begin -->` section is re-appended. |
| `LIFEOS/MEMORY` and `user-data/USER/MEMORY/` | Untouched by path rebasing; holds session history and state (`LIFEOS/MEMORY/STATE/settings-merge-snapshot.json` is refreshed after conversion). |
| `user-data/USER/` (outside `MEMORY/`) | Scaffolding fills only missing files; upstream migrations can migrate or retire existing files, and `convert.ts` rebases default-profile (`~/.claude`) paths in regular text files (`<= 1 MiB`). |
| `user-data/USER/CONFIG/settings.user.json` | Kept and updated in place with backported `settings.json` edits, non-default `cpb` keys (`claudeMdExcludes`, `model`, `agent`), rebased paths, and forced isolation `env` keys. |
| `settings.system.json` | Replaced by upstream's `OverlaySystem`, then rebased to `<root>` with isolation `env` keys forced. |
| `settings.json` | Updated during conversion (with `statusLine` preserved across upgrade and isolation `env` keys forced) and rebuilt on `SessionStart` from `settings.system.json` + `settings.user.json` when both exist. |
| `skills/LifeOS`, `LIFEOS/` (system files), `hooks/`, `agents/`, `commands/`, `workflows/` | Refreshed from the pinned upstream release; `convert.ts` keeps the 2 most recent backups in `.lifeos-skill-backups/`. |
| `.env` | Untouched by `convert.ts`. |
