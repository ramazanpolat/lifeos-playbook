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
- an audit after every run: nothing inside points at `~/.claude`, nothing outside changed.

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
