# Troubleshooting

## `convert.ts` Exit Codes

| Exit Code | Label | Meaning |
|---|---|---|
| `0` | Clean / Ready | Conversion succeeded and the post-install audit found 0 problems; `--plan` verified prerequisites are ready; or `--help` completed. |
| `1` | Failed | Runtime failure, including an unsuccessful `git` check (`git --version`), source fetch or verification failure, `install.sh` or `InstallAll.ts` failure, or file transform error. Logs `[convert] failed: <message>`. |
| `2` | Refused / Not ready | Explicit preflight/policy refusal, invalid arguments, missing conversion prerequisites (`make`/`g++` on Linux; with `--plan`, logs `[convert] not ready: <message>`), prohibited downgrade without `--allow-downgrade`, or a held lock. Real conversions log `[convert] refused: <message>` before changing anything. |
| `3` | Audit problems | Conversion ran to completion, but `auditInside` or `diffSnapshots` found one or more isolation violations. Problems are printed to stdout and recorded in `.lifeos-playbook/state.json`. |

## Linux Toolchain Refusal (`make` and `g++`)

Upstream's `DeployCore` step compiles `node-pty` from source using `node-gyp` on Linux because no prebuilt Linux binary is shipped. On Linux, when `make` or `g++` is missing from `PATH`:

- `--plan` prints the plan, reports what is missing, and exits `2`:

```text
[convert] not ready: LifeOS's installer compiles node-pty on Linux and needs make and g++: install them first (Debian/Ubuntu: sudo apt install build-essential)
```

- A real conversion refuses before locking or modifying files and exits `2`:

```text
[convert] refused: LifeOS's installer compiles node-pty on Linux and needs make and g++: install them first (Debian/Ubuntu: sudo apt install build-essential)
```

Install `make` and `g++` (for example, `sudo apt install build-essential` on Debian/Ubuntu) and re-run `convert.ts`.

## Upstream Step Timeouts (Safe to Rerun)

During `InstallAll.ts`, upstream runs `bun install` and compilation sub-steps under internal per-step timeouts (upstream represents a timeout as exit `124`). On a slow network or cold package cache, a step such as `DeployCore` can exceed its timeout (`300s`):

```text
[convert] InstallAll (fresh): ...
[convert]   DeployCore failed (exit 124): timed out after 300s
[convert]   an upstream step hit its time limit, usually a stalled `bun install` on a cold cache; the conversion is safe to run again once it has exited
[convert] failed: InstallAll failed: ...
```

The overall converter exits `1`. Wait for any background `bun` child processes to exit, then run the exact same `bun ~/.claude-playbooks/lifeos/playbook/convert.ts` command again. Packages already downloaded into `~/.bun` (or `~/Library/Caches/bun`) are reused, and `convert.ts` is idempotent.

## Downgrade Refusal (`--allow-downgrade`)

If the playbook already has a newer version of LifeOS installed (`LIFEOS/VERSION`) than the version specified in `playbook/upstream.json` (or `--pin`), `convert.ts` refuses with exit code `2`:

```text
[convert] refused: installed LifeOS 8.762.0 is newer than the pin 8.761.0; pass --allow-downgrade to go back
```

To intentionally convert an older release over a newer one, pass `--allow-downgrade`:

```bash
bun ~/.claude-playbooks/lifeos/playbook/convert.ts --allow-downgrade
```

## Held `convert.lock`

While running, `convert.ts` creates `<root>/.lifeos-playbook/convert.lock` atomically (`wx`) containing its PID, and removes the lock on exit only if the file still holds its own PID.

- **Dead owner (interrupted conversion)**: If the PID recorded in `convert.lock` is no longer running (`process.kill(pid, 0)` fails), the next run automatically logs:

```text
[convert] taking over the lock of pid 12345, which is no longer running (an interrupted conversion)
```

  removes the stale lock, acquires a new one atomically, and continues.

- **Live owner**: If the PID recorded in `convert.lock` is still running (another conversion is active, or the OS reused the PID), `convert.ts` exits `2`:

```text
[convert] refused: another conversion is running (pid 12345); wait for it to finish, or remove /home/user/.claude-playbooks/lifeos/.lifeos-playbook/convert.lock if that process is not a conversion
```

Verify that no `convert.ts` or `InstallAll.ts` process is running for that playbook root, then remove the lock file manually if the PID belongs to an unrelated process:

```bash
rm -f ~/.claude-playbooks/lifeos/.lifeos-playbook/convert.lock
```

## Inspecting `.lifeos-playbook/state.json` and Kept Staging

Every conversion that reaches the audit step (exit codes `0` and `3`) writes `<root>/.lifeos-playbook/state.json`:

```json
{
  "version": "8.761.0",
  "commit": "fb9aef4640a73feae4c2e6483b26f58491ce2665",
  "converted": "2026-10-28-11_45",
  "mode": "fresh",
  "from": null,
  "components": [
    "tooltips",
    "spinnerverbs",
    "agents",
    "commands",
    "workflows"
  ],
  "declinedServices": [
    "conduit",
    "conduit.insight",
    "deriver",
    "modelsync",
    "pulse",
    "pulse-menubar"
  ],
  "claudeMdReplaced": false,
  "problems": []
}
```

- `mode`: `"fresh"` on first conversion, `"upgrade"` when `LIFEOS/VERSION`, `settings.json`, and `LIFEOS/USER` already existed before the run.
- `from`: previous `LIFEOS/VERSION` string on `"upgrade"`, or `null` on `"fresh"`.
- `claudeMdReplaced`: `true` when an upgrade replaced `<root>/CLAUDE.md` with upstream's template and the body outside the playbook section differed from the previous file (backed up in `.lifeos-overlay-backups/`), `false` otherwise.
- `problems`: empty array `[]` when exit code is `0`; lists each inside-audit or outside-snapshot violation when exit code is `3`.

If a network-fetched conversion fails before completing (`exit 1`), `convert.ts` preserves the fetched upstream source for inspection and prints:

```text
[convert] source kept for diagnosis: /home/user/.claude-playbooks/lifeos/.lifeos-playbook/staging/fb9aef4640a73feae4c2e6483b26f58491ce2665
```

You can also keep the staging directory on a successful run by passing `--keep-staging`.
