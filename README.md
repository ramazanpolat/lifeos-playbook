# lifeos-playbook

Runs [LifeOS](https://github.com/danielmiessler/LifeOS) as an isolated Claude Code
[playbook](https://github.com/ramazanpolat/claude-playbooks): its own config directory
(`CLAUDE_CONFIG_DIR`), apart from `~/.claude` and from every other playbook.

## Why

LifeOS installs into a Claude Code config root and, by default, also into your home
directory: launchd jobs, a data home in `~/.config/LIFEOS`, a terminal layer, shell aliases.
This repo converts an upstream LifeOS release into a playbook that keeps all of it inside
one directory. It does not fork LifeOS: it drives each release's own installer with a fixed
policy, so a new upstream release converts without porting work.

## How

Requirements: [Claude Code](https://claude.com/claude-code), [cpb](https://github.com/ramazanpolat/claude-playbooks)
4+, bun 1.2+, git. On Linux, LifeOS's installer compiles node-pty, so it also needs `make` and a
C++ compiler (Debian/Ubuntu: `sudo apt install build-essential`); `--plan` tells you if they are missing.

```bash
cpb CREATE PLAYBOOK lifeos FROM https://github.com/ramazanpolat/lifeos-playbook
bun ~/.claude-playbooks/lifeos/playbook/convert.ts --plan    # what it will do; names anything missing
bun ~/.claude-playbooks/lifeos/playbook/convert.ts           # install LifeOS into the playbook (1-3 min)
bun ~/.claude-playbooks/lifeos/playbook/convert.ts --check   # is it healthy?
lifeos                                                       # start it, then type /LifeOS setup
```

Every PR runs `ci`: a leak scan, unit tests, the e2e suite on Linux and macOS, and the cpb
round trip. `playbook/upstream.json` pins one upstream release by commit. A daily GitHub Action
(`upstream-watch`) checks for a newer release, converts it in a sandbox with the e2e suite on
Linux and macOS, and only when both pass opens a PR that pins it, for the owner to merge.
`cpb update lifeos` then converts the new pin in place.

What the conversion does, and leaves out:

- config root and data home (`user-data/`) inside the playbook directory;
- every LifeOS background service declined (Pulse, launchd and systemd jobs), and `statusLine`
  set aside during upgrades so upstream schedules no machine-wide refresher job;
- components that write outside the root left out: `statusline`, `helm`, `pulse`,
  `worksweep`, `derivedsync`;
- `~/.claude` paths in `settings.json`, `settings.system.json`, and eligible `USER` files
  rewritten to the playbook root;
- `LIFEOS_CONFIG_PATH` pinned to the playbook's own config in settings and the installer
  environment (upstream otherwise reads `~/.claude/LIFEOS/USER/CONFIG/LIFEOS_CONFIG.toml`,
  whatever `CLAUDE_CONFIG_DIR` says);
- the system settings layer established from the first conversion, upstream's merge snapshot
  written after every run, and `SettingsBackport` run before upgrades, so hand edits to
  `settings.json` survive the per-session rebuild;
- an audit after every run: nothing inside points at `~/.claude`, watched paths outside did not
  change.

Personal instructions go in `CLAUDE.local.md` next to `CLAUDE.md`. Updates replace
`CLAUDE.md` with upstream's template (the old one is backed up in `.lifeos-overlay-backups/`);
`CLAUDE.local.md` is imported from it and never touched.

Three things do land outside the playbook root:

- package-manager and build caches (`~/.bun`, `~/.cache`, `~/.npm`, `~/Library/Caches`), which
  `bun install` and `node-gyp` share across every project on the machine;
- `~/.local/state/lifeos/`, where about twenty LifeOS subsystems (STATVS, Atlas, Vigil,
  SendGate, ...) keep per-user runtime state once sessions run. Upstream hard-codes the path in
  most of them, so the converter cannot redirect it without patching LifeOS code;
- `/tmp/lifeos-session-start.txt`, a session timestamp written by upstream's `SessionStart` hook.

The last two are shared by every LifeOS install of the same user and are left behind by
`cpb DROP PLAYBOOK`. The e2e suite reports them by name and checks every other path strictly.

## Layout

| Path | What |
|---|---|
| `playbook/convert.ts` | the converter (`--plan`, `--src`, `--allow-downgrade`) |
| `playbook/upstream.json` | the pinned upstream release (repo, version, tag, commit) |
| `playbook/watch.ts` | detects a newer release, runs local e2e (`--bump`, without pinning), or applies a tested pin (`--apply <file>`) |
| `playbook/bin/migrate` | the `cpb update` hook: runs the converter |
| `playbook/tests/` | unit tests (`bun test`), `hook-smoke.ts` (fires registered hooks), `e2e.sh`, `cpb.sh`, `journey.sh` |

`e2e.sh` and `cpb.sh` run upstream's installer under a throwaway `HOME`, and `journey.sh`
exercises a full install against the machine's real `HOME`: run them on a disposable machine
or a CI runner, not a workstation.

## Documentation

- [`docs/`](docs/README.md) -- tutorials and operational guides
- [`examples/`](examples/README.md) -- runnable command examples from `--plan` to full lifecycle
- [`AGENTS.md`](AGENTS.md) -- instructions for coding agents installing or updating this playbook
