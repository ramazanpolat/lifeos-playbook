# What the Conversion Changes

`playbook/convert.ts` does not fork LifeOS. Instead, it drives the upstream release's own installer (`install/install.sh` and `Tools/InstallAll.ts`) under a fixed isolation policy, applies deterministic post-install transforms, and audits the result.

## Isolation Policy

### Config Root, `LIFEOS_CONFIG_PATH`, and Process Environment

Before invoking any upstream script, `convert.ts` redirects config, data, skill, and temporary locations inside the playbook root (`<root>`). Other paths in upstream settings (for example, `PROJECTS_DIR`, which defaults to `$HOME/Projects` in `settings.system.json`) are not universally redirected.

`convert.ts` pins three environment variables (`rootEnvFor`) in `<root>/settings.json`, `<root>/settings.system.json` (when present), `<root>/user-data/USER/CONFIG/settings.user.json`, and the installer process environment:

- `LIFEOS_CONFIG_DIR`: `<root>/user-data`
- `LIFEOS_DIR`: `<root>/LIFEOS`
- `LIFEOS_CONFIG_PATH`: `<root>/user-data/USER/CONFIG/LIFEOS_CONFIG.toml`

`LIFEOS_CONFIG_PATH` is critical because upstream's `LifeosConfig.ts` defaults to `~/.claude/LIFEOS/USER/CONFIG/LIFEOS_CONFIG.toml` regardless of `CLAUDE_CONFIG_DIR`, and `lifeosUserDir()` falls back to `~/.claude/LIFEOS/USER` when that file is missing.

For every upstream child process (`upstreamEnv`), `convert.ts` also sets:

- `CLAUDE_CONFIG_DIR`: `<root>`
- `LIFEOS_SKILLS_DIR`: `<root>/skills`
- `TMPDIR`: `<root>/.lifeos-playbook/tmp`
- `ELECTRON_SKIP_BINARY_DOWNLOAD`: `1` (skips downloading a 100 MB Electron binary for Pulse Desktop)

Caller environment variables that outrank or redirect the config root (`CLAUDE_PLUGIN_ROOT`, `LIFEOS_HARNESS`, `LIFEOS_TAG`, `LIFEOS_TARBALL_URL`, `LIFEOS_EXPECTED_SHA256`, `DRY_RUN`) are deleted before running upstream commands.

When running upstream's `install/install.sh`, `convert.ts` additionally sets:

- `LIFEOS_SKIP_ALIAS=1`: prevents editing `~/.zshrc`, `~/.bashrc`, `~/.bash_profile`, or `~/.profile`
- `LIFEOS_NO_LAUNCH=1`: prevents launching an interactive session during installation
- `LIFEOS_AUTO_INSTALL_BUN=0`: prevents modifying the user's Bun installation

### Core Services Declined and Upgrade Statusline Guard

The converter queries `bun <skillRoot>/install/LIFEOS/TOOLS/Services.ts list --json`, extracts every service with `optIn: false` (`coreServices`), strips the `com.lifeos.` prefix, and passes the sorted list to `InstallAll.ts --decline-services` so registry core services are declined.

Declining registry core services alone does not stop upstream's `RefreshStatusline` step during upgrades: `RefreshStatusline` always runs in the upgrade chain and schedules a machine-wide launchd job (`com.lifeos.workflows-dispatcher`) whenever `settings.json` configures the shipped `LIFEOS_StatusLine.sh`. During an upgrade, `convert.ts` temporarily removes `statusLine` from `settings.json` before invoking `InstallAll.ts` and restores it in `finally`, preventing that job from being scheduled while keeping the statusline configuration intact.

### Component Allow-List

Upstream's `Tools/DeployComponents.ts` defines `DOCUMENTED_OPTIONAL_COMPONENTS`. `convert.ts` intersects that list with `WANTED_COMPONENTS`:

- **Installed (`WANTED_COMPONENTS`)**: `tooltips`, `spinnerverbs`, `agents`, `commands`, `workflows`
- **Excluded (write outside the config root)**: `statusline`, `helm`, `pulse`, `worksweep`, `derivedsync`

If an upstream release offers none of `WANTED_COMPONENTS`, `convert.ts` aborts rather than passing an empty `--components` flag (which would cause `InstallAll.ts` to deploy its default set).

### Rebased Default-Profile and Data-Home Paths

Upstream templates and settings files contain hardcoded references to the default Claude Code profile and to the default data home. After `InstallAll.ts` completes, `convert.ts` rewrites every boundary-anchored spelling of the default root (`~/.claude`, `$HOME/.claude`, `${HOME}/.claude`, and `/home/user/.claude`) to `<root>`, and of the default data home (`~/.config/LIFEOS` in the same four spellings) to `<root>/user-data`. The second matters for permissions: upstream's settings carry deny and ask rules for files in the data home (the USER repo's `.git/hooks` and `.git/config`, Proof receipts, `settings.user.json`), and they must name the playbook's data home to protect it. The rewrite covers:

- `<root>/settings.json` and `<root>/settings.system.json` (when present)
- Every regular text file (`<= 1 MiB`, non-binary, non-symlink) under `<root>/user-data/USER`, except `user-data/USER/MEMORY/`, `.git`, `node_modules`, and `user-data/USER/CONFIG/settings.user.json` (rebased separately). For example, `pulse_templates_dir` in `user-data/USER/CUSTOMIZATIONS/SKILLS/LifeOS/Config.md` is rebased so upstream's `ScaffoldUser` follows it inside the root on subsequent upgrades.

Look-alike paths (`~/.claude-playbooks`, `~/.claude.json`, `~/.claude.bak`) and embedded home paths (`/backup/home/user/.claude`) are not matched.

### Exempt `claudeMdExcludes`

When `cpb` creates a playbook, it writes `claudeMdExcludes: ["/home/user/.claude/**"]` into `<root>/settings.json` so Claude Code ignores the global `~/.claude/CLAUDE.md` when running inside the playbook.

`REBASE_EXEMPT_KEYS` (`["claudeMdExcludes"]`) exempts this key from path rebasing and from the default-root path check during the audit. Rebasing `claudeMdExcludes` to `<root>/**` would cause Claude Code to ignore the playbook's own `CLAUDE.md`.

### User Settings Layer, Backport, and Merge Snapshot

Upstream registers a `SessionStart` hook (`SettingsBackport` followed by `MergeSettings`). When both `settings.system.json` and `user-data/USER/CONFIG/settings.user.json` exist, the hook merges them (with `settings.user.json` winning key by key), preserves qualifying installer-owned keys (`hooks`, `statusLine`, `spinnerVerbs`, `spinnerTipsOverride`) from the existing `settings.json` when neither layer defines them, and backports edits from `settings.json` into `settings.user.json` when a merge snapshot (`LIFEOS/MEMORY/STATE/settings-merge-snapshot.json`) is available. When either input layer is missing, merging is a no-op.

To keep playbook isolation keys, `cpb` keys, and hand edits intact across session rebuilds and upgrades, `convert.ts`:

1. **Before an upgrade**: If `LIFEOS/MEMORY/STATE/settings-merge-snapshot.json` exists, runs `bun <root>/LIFEOS/TOOLS/SettingsBackport.ts` to fold any hand edits made to `settings.json` since the last merge into `user-data/USER/CONFIG/settings.user.json` before upstream touches `settings.json`.
2. **In `user-data/USER/CONFIG/settings.user.json`**:
   - Rebases any default-profile paths (excluding `claudeMdExcludes`).
   - Forces `env.LIFEOS_CONFIG_DIR` (`<root>/user-data`), `env.LIFEOS_DIR` (`<root>/LIFEOS`), and `env.LIFEOS_CONFIG_PATH` (`<root>/user-data/USER/CONFIG/LIFEOS_CONFIG.toml`).
   - Copies `CPB_KEYS` (`claudeMdExcludes`, `model`, `agent`) from the live `settings.json` into `settings.user.json` when their values differ from the system layer and changed since the last merge snapshot (`preserveKeys`); when the live value still equals the snapshot, the user layer is the newer state and is kept, including a deletion there.
3. **After conversion**: Writes `LIFEOS/MEMORY/STATE/settings-merge-snapshot.json` equal to the converted `settings.json`, then runs the registered `SessionStart` rebuild once (its backport is then a no-op) and writes the snapshot again, so `settings.json` holds this release's merge and hand edits made afterward are seen as drift and backported on the next session start or upgrade. A failed rebuild fails the conversion.

### `CLAUDE.md` Section and `CLAUDE.local.md`

On a fresh playbook, `convert.ts` detects the `<!-- lifeos-playbook:bootstrap -->` marker in `<root>/CLAUDE.md` and moves that file to `<root>/.lifeos-playbook/bootstrap-CLAUDE.md` before `InstallAll.ts` runs (because upstream's `InstallSettings` writes `CLAUDE.md` only when the file does not exist). On an upgrade, upstream's `OverlaySystem` backs up the existing `<root>/CLAUDE.md` in `<root>/.lifeos-overlay-backups/<timestamp>/CLAUDE.md.bak` and writes the release's `CLAUDE.md` template.

After `InstallAll.ts` finishes, `convert.ts` appends or replaces (`upsertSection`) a bounded section delimited by `<!-- lifeos-playbook:begin -->` and `<!-- lifeos-playbook:end -->` documenting the playbook root, `user-data` location, pinned version and commit, `cpb update` command, isolation rules, and a trailing `@CLAUDE.local.md` import line. Personal instructions go in `<root>/CLAUDE.local.md`, which updates never touch; `.lifeos-playbook/state.json` records `claudeMdReplaced` when an upgrade replaced prior `CLAUDE.md` content.

## The Audit and Exit Code 3

Step 7 of `convert.ts` runs two checks:

1. **Inside audit (`auditInside`)**:
   - Checks `settings.json`, `settings.system.json` and `user-data/USER/CONFIG/settings.user.json` (excluding `claudeMdExcludes`) for any remaining default-root or default-data-home spellings (`~/.claude`, `~/.config/LIFEOS` and their `$HOME`, `${HOME}` and `/home/user` forms).
   - Verifies no entry in `claudeMdExcludes` points lexically under `<root>`.
   - Verifies `settings.json` has `env.LIFEOS_CONFIG_DIR === "<root>/user-data"`, `env.LIFEOS_DIR === "<root>/LIFEOS"`, and `env.LIFEOS_CONFIG_PATH === "<root>/user-data/USER/CONFIG/LIFEOS_CONFIG.toml"`, and that `<root>/user-data/USER/CONFIG/LIFEOS_CONFIG.toml` exists.
   - Scans every hook command and the `statusLine` command in `settings.json` for absolute script paths (`*.ts`, `*.sh`, `*.js`, allowing the shell-safe characters upstream leaves unquoted, such as `+ , = : % ~`) and checks that each is under `<root>`.
   - Requires hooks to be registered, including the `SessionStart` settings rebuild (`MergeSettings`).
   - Verifies `LIFEOS/USER` and `LIFEOS/MEMORY` resolve exactly to `user-data/USER` and `user-data/USER/MEMORY`.
2. **Outside snapshot diff (`diffSnapshots`)**:
   Observes selected outside paths (`watchedPaths`) before and after conversion, detecting creation, removal and modification. Directories are recorded recursively (path, kind, mtime, size; `MEMORY`, `node_modules` and `.git` are not descended into), so a file rewritten in place inside an existing LifeOS tree is reported. Separately, every file the converter itself writes is confined: a write whose target, symlinks resolved, lands outside `<root>` is refused. The watched locations are where upstream's installer is known to write when not isolated:
   - `~/Library/LaunchAgents` (entries matching `/lifeos|pai\./i`)
   - `~/Library/Application Support/LifeOS`
   - `~/Library/Logs/lifeos`
   - `~/.config/LIFEOS`
   - `~/.config/systemd/user` (entries matching `/lifeos|pai\./i`)
   - `~/.config/herdr/config.toml`
   - `~/.config/kitty`
   - `~/.local/bin/helm`
   - `~/Applications/Helm.app`
   - `~/.hammerspoon/init.lua`
   - `~/.hammerspoon/lifeos.lua`
   - `~/.zshrc`, `~/.bashrc`, `~/.bash_profile`, `~/.profile`, `~/.gitconfig`
   - `~/.claude/LIFEOS`, `~/.claude/skills/LifeOS`, `~/.claude/settings.system.json`

All findings are recorded in the `problems` array of `<root>/.lifeos-playbook/state.json`. If `problems` is non-empty, `convert.ts` prints each problem and exits with code `3`.

## Known Writes Outside the Playbook Root

The converter watches `watchedPaths`, while `e2e.sh` inspects the entire sandbox `$HOME` and `hook-smoke.ts` inspects `/tmp`. Three kinds of writes land outside `<root>`:

1. **Package-manager and build caches during conversion**: `bun install` and `node-gyp` use their standard cache directories (`~/.bun`, `~/.cache`, `~/.npm`, and on macOS `~/Library/Caches/bun` and `~/Library/Caches/node-gyp`). `e2e.sh` allows these cache paths; they are shared across projects on the machine and hold no LifeOS configuration or user state.
2. **Shared session-start timestamp at hook runtime**: Upstream's `SessionStart` hook writes `/tmp/lifeos-session-start.txt`, shared by every LifeOS install on the machine. `playbook/tests/hook-smoke.ts` reports newly appearing `/tmp` entry names matching `/lifeos|pai-/i`; it does not detect rewrites of existing files.
3. **Per-user runtime state at hook and session runtime**: about twenty LifeOS subsystems (STATVS, Atlas, Vigil, SendGate, Errata, ...) keep runtime state in `~/.local/state/lifeos/`. Some honour an override variable, but most hard-code the path (for example `LIFEOS/STATVS/lib/record.ts`), so the converter cannot redirect it without patching LifeOS code. It is shared by every LifeOS install of the same user and left behind by `cpb DROP PLAYBOOK`; `e2e.sh` reports it by name (`note: upstream runtime state in ~/.local/state/lifeos`) and checks every other path strictly.
