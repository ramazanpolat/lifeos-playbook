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

```bash
cpb CREATE PLAYBOOK lifeos FROM https://github.com/ramazanpolat/lifeos-playbook
bun ~/.claude-playbooks/lifeos/playbook/convert.ts --plan   # what it will do
bun ~/.claude-playbooks/lifeos/playbook/convert.ts          # install LifeOS into the playbook
lifeos                                                      # start it; run /LifeOS setup
```

Every PR runs `ci`: a leak scan, unit tests, the e2e suite on Linux and macOS, and the cpb
round trip. `playbook/upstream.json` pins one upstream release by commit. A daily GitHub Action
(`upstream-watch`) checks for a newer release, converts it in a sandbox with the e2e suite,
and pins it only when that passes. `cpb update lifeos` then converts the new pin in place.

What the conversion does, and leaves out:

- config root and data home (`user-data/`) inside the playbook directory;
- every LifeOS background service declined (Pulse, launchd and systemd jobs);
- components that write outside the root left out: `statusline`, `helm`, `pulse`,
  `worksweep`, `derivedsync`;
- `~/.claude` paths in `settings.json` and `settings.system.json` rewritten to the playbook root;
- `LIFEOS_CONFIG_PATH` pinned to the playbook's own config (upstream otherwise reads
  `~/.claude/LIFEOS/USER/CONFIG/LIFEOS_CONFIG.toml`, whatever `CLAUDE_CONFIG_DIR` says);
- an audit after every run: nothing inside points at `~/.claude`, nothing outside changed.

Personal instructions go in `CLAUDE.local.md` next to `CLAUDE.md`. Updates replace
`CLAUDE.md` with upstream's template (the old one is backed up in `.lifeos-overlay-backups/`);
`CLAUDE.local.md` is imported from it and never touched.

The one thing that does land outside is package-manager cache: `bun install` and node-gyp
use their usual cache directories (`~/.bun`, `~/.cache`, `~/Library/Caches`), shared with
every other project on the machine.

Two upstream behaviours also reach outside, and the converter cannot redirect them without
patching LifeOS code: about twenty LifeOS subsystems (STATVS, Atlas, Vigil, SendGate, ...)
keep per-user runtime state in `~/.local/state/lifeos/`, and one hook writes a session
timestamp to `/tmp/lifeos-session-start.txt`. Both are shared by every LifeOS install of the
same user; the tests report them by name.

## Layout

| Path | What |
|---|---|
| `playbook/convert.ts` | the converter (`--plan`, `--src`, `--allow-downgrade`) |
| `playbook/upstream.json` | the pinned upstream release (repo, version, tag, commit) |
| `playbook/watch.ts` | finds a newer release, runs e2e, rewrites the pin |
| `playbook/bin/migrate` | the `cpb update` hook: runs the converter |
| `playbook/tests/` | unit tests (`bun test`), `e2e.sh` (convert, rerun, upgrade in a throwaway HOME), `cpb.sh` (install, convert, `cpb update`, session rebuild) |

Requirements: bun 1.2+, git. On Linux, LifeOS's installer compiles node-pty, so it also
needs `make` and a C++ compiler (`apt install build-essential`).

The e2e suites run upstream's installer under a throwaway `HOME`: run them on a disposable
machine or a CI runner, not a workstation.
