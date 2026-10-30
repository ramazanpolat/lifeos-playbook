# Updating

Updates move an existing `lifeos` playbook to a newly pinned upstream LifeOS release in place, keeping `user-data/`, backported settings overrides, and `CLAUDE.local.md` while refreshing LifeOS's system files and `CLAUDE.md` template.

## How a New Upstream Release Reaches an Install

1. **Daily detection and e2e verification**: `.github/workflows/upstream-watch.yml` runs `bun playbook/watch.ts --candidate-out candidate.json` on a daily schedule (`17 5 * * *`) and on manual dispatch. When `danielmiessler/LifeOS` publishes a higher version or moves the current release tag to a new commit, the workflow runs `playbook/tests/e2e.sh` against the candidate on both `ubuntu-latest` and `macos-latest` (testing fresh conversion, hooks, idempotent rerun, and upgrade from the current pin).
2. **Pin update via pull request**: Only if both OS targets pass `e2e.sh`, the `pin` job runs `bun playbook/watch.ts --apply "$RUNNER_TEMP/candidate.json"`, which updates `playbook/upstream.json` and bumps the `version` field in `.playbook` (for example, `8.761.0+pb.1` to `8.762.0+pb.1`, or `8.761.0+pb.2` if the same upstream tag moved to a new commit). The job opens a PR into `main`, starts `ci` on it, and squash-merges it automatically once the required checks pass.
3. **Local update with `cpb`**: On the user machine, running `cpb update` pulls the new playbook commit and triggers the migration hook declared in `.playbook`:

```toml
[update]
preserve = ["CLAUDE.md"]
migrate = "playbook/bin/migrate"
```

4. **Migration hook execution**: `cpb update` invokes `playbook/bin/migrate <from-version> <to-version> <install-dir>`, which executes:

```bash
bun "$3/playbook/convert.ts" --root "$3" --migrate-from "$1" --migrate-to "$2"
```

5. **In-place upgrade conversion**: `playbook/convert.ts` sees that `LIFEOS/VERSION`, `settings.json`, and `LIFEOS/USER` already exist in the playbook root, so it runs in `upgrade` mode. It fetches the new pinned commit, runs `LIFEOS/TOOLS/SettingsBackport.ts` (when a merge snapshot exists) to fold hand edits into `settings.user.json`, runs upstream's `install.sh`, sets a shipped `statusLine` aside so upstream schedules no machine-wide refresher job, runs the `InstallAll.ts` upgrade chain, restores `statusLine`, rebases default-profile paths, updates `CLAUDE.md` with the playbook section, writes a fresh merge snapshot, and runs the post-conversion audit.

## Running an Update

Update the playbook with `cpb`:

```bash
cpb update lifeos
```

For non-interactive scripts, pass `--yes`:

```bash
cpb update lifeos --yes
```

## What Upgrades Keep and Replace

See [Personal Instructions and Settings](personal-instructions-and-settings.md) for the full breakdown of where personal customizations belong.

- **`user-data/` (`LIFEOS/USER` and `LIFEOS/MEMORY`)**: Scaffolding fills missing `USER` files. Upgrades can migrate or retire existing files, and the converter rebases default-profile paths in eligible text files (never modifying `user-data/USER/MEMORY/`) and updates the user settings layer.
- **User settings layer, backport, and snapshot (`user-data/USER/CONFIG/settings.user.json`)**: The `SessionStart` hook (`MergeSettings`) rebuilds `settings.json` when both settings layers exist; otherwise it reports that there is nothing to merge. Before an upgrade, `convert.ts` runs `LIFEOS/TOOLS/SettingsBackport.ts` (when `LIFEOS/MEMORY/STATE/settings-merge-snapshot.json` exists) so hand edits made to `settings.json` fold into `settings.user.json`. After upgrading, `convert.ts` forces `env.LIFEOS_CONFIG_DIR`, `env.LIFEOS_DIR`, and `env.LIFEOS_CONFIG_PATH` in `settings.json`, `settings.system.json`, and `settings.user.json`, copies `claudeMdExcludes`, `model`, and `agent` into `settings.user.json` when their values differ from the system layer (a value you set in `settings.user.json` itself since the last rebuild is kept), and writes `LIFEOS/MEMORY/STATE/settings-merge-snapshot.json` equal to the converted `settings.json`.
- **`CLAUDE.md` and `CLAUDE.local.md`**: `cpb` preserves `CLAUDE.md` during the source update (`preserve = ["CLAUDE.md"]`). The migration then replaces it from upstream's template, retaining the previous file in `.lifeos-overlay-backups/<timestamp>/CLAUDE.md.bak`, reinserts the playbook section (which imports `@CLAUDE.local.md`), and sets `claudeMdReplaced` in `.lifeos-playbook/state.json`. Personal instructions belong in `CLAUDE.local.md`, which nothing overwrites.
- **`statusLine`**: When `settings.json` configures LifeOS's shipped `LIFEOS_StatusLine.sh`, `convert.ts` sets `statusLine` aside before `InstallAll.ts` so upstream's `RefreshStatusline` step schedules no machine-wide launchd refresher job, then restores `statusLine` afterward.
- **Skill backups (`.lifeos-skill-backups/`)**: Upstream's `install.sh` backs up the previous `skills/LifeOS` tree into `<root>/.lifeos-skill-backups/LifeOS.backup-*`. After conversion, `convert.ts` prunes older backups and keeps the 2 most recent ones (`SKILL_BACKUPS_KEPT = 2`).
