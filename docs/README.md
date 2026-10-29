# Documentation

Technical documentation for `lifeos-playbook`, a policy-driven converter that installs an upstream [LifeOS](https://github.com/danielmiessler/LifeOS) release into an isolated Claude Code playbook (`CLAUDE_CONFIG_DIR`) managed by `cpb`.

## Tutorials

- [First Install](tutorials/first-install.md) -- create the playbook with `cpb CREATE PLAYBOOK`, inspect `--plan`, run the conversion, and launch `/LifeOS setup`.

## Guides

- [Updating](guides/updating.md) -- how `upstream-watch` pins new releases via pull request, how `cpb update` runs `playbook/bin/migrate`, and what upgrades preserve or replace.
- [Personal Instructions and Settings](guides/personal-instructions-and-settings.md) -- where personal instructions belong (`CLAUDE.local.md`), how settings edits survive session rebuilds and upgrades (user layer, `SettingsBackport`, merge snapshot), and what upgrades replace.
- [What the Conversion Changes](guides/what-the-conversion-changes.md) -- the isolation policy, `LIFEOS_CONFIG_PATH` and environment pins, declined services, statusline handling during upgrades, component allow-list, path rebasing, `claudeMdExcludes` exemption, user settings layer and merge snapshot, `CLAUDE.md` section, post-conversion audit (exit code `3`), and outside writes.
- [Offline Conversion](guides/offline-conversion.md) -- converting from a local upstream checkout with `--src` and `--unverified-src`.
- [The Watcher](guides/the-watcher.md) -- `playbook/watch.ts` modes (report, `--candidate-out`, `--bump`, `--apply`), exit codes, the three `upstream-watch.yml` CI jobs, and required GitHub Actions repository permissions.
- [Testing](guides/testing.md) -- running `bun test`, `playbook/tests/hook-smoke.ts`, `playbook/tests/e2e.sh`, `playbook/tests/cpb.sh`, and `playbook/tests/journey.sh`, why end-to-end and journey suites require a disposable machine, and Linux build dependencies (`make` and `g++`).
- [Troubleshooting](guides/troubleshooting.md) -- `convert.ts` exit codes (`0`, `1`, `2`, `3`), `--plan` readiness checks, Linux toolchain refusals, upstream step timeouts, downgrade refusals (`--allow-downgrade`), atomic `convert.lock` takeover, and `.lifeos-playbook/state.json`.
