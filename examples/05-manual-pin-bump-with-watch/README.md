# 05: Manual Pin Bump with `watch.ts`

Check whether upstream `danielmiessler/LifeOS` has published a newer release (or moved the current release tag), run the end-to-end test suite against the candidate on disposable Linux and macOS machines, and apply the pin to `playbook/upstream.json` and `.playbook`.

## 1. Check for a Newer Release (Report Mode)

```bash
bun playbook/watch.ts
```

When the pin is already current (exit code `0`):

```text
[watch] up to date: 8.761.0@fb9aef4640a7
```

When a newer upstream release is available (exit code `10`):

```text
[watch] new release: 8.761.0@fb9aef4640a7 -> 8.762.0@1a2b3c4d5e6f
```

When the existing version tag was force-moved to a new commit (exit code `10`):

```text
[watch] release tag moved: 8.761.0@fb9aef4640a7 -> 8.761.0@9f8e7d6c5b4a
```

## 2. Step-by-Step Candidate Write, Test, and Apply

Continue to `e2e.sh` only when candidate detection exits `10` (when up to date, `--candidate-out` exits `0` without writing a file; stop on `0` or any error). `--apply` performs no e2e verification, so run it only after `e2e.sh` exits `0` on both Linux and macOS for the exact candidate file:

```bash
code=0
bun playbook/watch.ts --candidate-out /tmp/candidate.json || code=$?
if [ "$code" -eq 10 ]; then
  bash playbook/tests/e2e.sh --pin /tmp/candidate.json --from-pin playbook/upstream.json
fi
```

Once `e2e.sh` passes (`0`) on both disposable Linux and macOS machines, apply the candidate pin:

```bash
bun playbook/watch.ts --apply /tmp/candidate.json
```

Expected output of `--apply` (exit code `11`):

```text
[watch] pinned 8.762.0@1a2b3c4d5e6f; playbook version 8.761.0+pb.1 -> 8.762.0+pb.1
```

## 3. Single-OS Candidate Check (`--bump`)

On a disposable VM or container, `--bump` combines detection and `e2e.sh` on this machine's OS. Because pinning requires both Linux and macOS, `--bump` keeps the candidate file and never rewrites `playbook/upstream.json` or `.playbook`:

```bash
bun playbook/watch.ts --bump
```

Expected output shape when `e2e.sh` passes on a cross-commit candidate (exit code `10`):

```text
[watch] new release: 8.761.0@fb9aef4640a7 -> 8.762.0@1a2b3c4d5e6f
[watch] running the e2e suite against the candidate (fresh install, rerun, upgrade from the pin)
e2e: sandbox /tmp/lifeos-e2e-abc123
== fresh install of 8.762.0
...
e2e: 38 passed, 0 failed
[watch] e2e passed on linux; pin unchanged. Pinning needs both OSes: the upstream-watch workflow does it,
[watch] or run the suite on the other OS too, then: bun playbook/watch.ts --apply /home/user/lifeos-playbook/playbook/.candidate-8.762.0.json
```

If `e2e.sh` fails, `watch.ts --bump` removes `playbook/.candidate-<version>.json` (unless `--candidate-out` was specified), leaves `playbook/upstream.json` and `.playbook` untouched, and exits `12`:

```text
[watch] e2e failed; pin unchanged
```
