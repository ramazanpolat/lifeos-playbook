# 01: Plan Only

Run `playbook/convert.ts --plan` to execute preflight checks, inspect the conversion policy, and verify conversion prerequisites without changing any files on disk.

## Command

```bash
bun ~/.claude-playbooks/lifeos/playbook/convert.ts --plan
```

## Expected Output (Fresh Playbook, Ready)

```text
[convert] root      /home/user/.claude-playbooks/lifeos
[convert] release   danielmiessler/LifeOS 8.761.0 @ fb9aef4640a7
[convert] mode      fresh
[convert] user data /home/user/.claude-playbooks/lifeos/user-data
[convert] source    fetch github.com/danielmiessler/LifeOS fb9aef4640a73feae4c2e6483b26f58491ce2665
[convert] plan only: components tooltips,spinnerverbs,agents,commands,workflows (minus any the release lacks); all core services declined
[convert] ready: run the same command without --plan to convert
```

Exit code: `0`.

## Expected Output (Already Converted Playbook, Ready)

When `LIFEOS/VERSION`, `settings.json`, and `LIFEOS/USER` already exist in the playbook root, `--plan` reports `upgrade` mode and the currently installed version:

```text
[convert] root      /home/user/.claude-playbooks/lifeos
[convert] release   danielmiessler/LifeOS 8.761.0 @ fb9aef4640a7
[convert] mode      upgrade (installed 8.761.0)
[convert] user data /home/user/.claude-playbooks/lifeos/user-data
[convert] source    fetch github.com/danielmiessler/LifeOS fb9aef4640a73feae4c2e6483b26f58491ce2665
[convert] plan only: components tooltips,spinnerverbs,agents,commands,workflows (minus any the release lacks); all core services declined
[convert] ready: run the same command without --plan to convert
```

Exit code: `0`.

## Expected Output (Linux Without `make` and `g++`, Not Ready)

On Linux, if `make` or `g++` is missing from `PATH`, `--plan` still prints the plan, names the missing prerequisite, and exits `2`:

```text
[convert] root      /home/user/.claude-playbooks/lifeos
[convert] release   danielmiessler/LifeOS 8.761.0 @ fb9aef4640a7
[convert] mode      fresh
[convert] user data /home/user/.claude-playbooks/lifeos/user-data
[convert] source    fetch github.com/danielmiessler/LifeOS fb9aef4640a73feae4c2e6483b26f58491ce2665
[convert] plan only: components tooltips,spinnerverbs,agents,commands,workflows (minus any the release lacks); all core services declined
[convert] not ready: LifeOS's installer compiles node-pty on Linux and needs make and g++: install them first (Debian/Ubuntu: sudo apt install build-essential)
```

Exit code: `2`.
