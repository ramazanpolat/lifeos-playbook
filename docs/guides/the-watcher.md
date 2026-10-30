# The Watcher

`playbook/watch.ts` and `.github/workflows/upstream-watch.yml` track upstream `danielmiessler/LifeOS` releases, test candidate pins with the end-to-end suite, and update `playbook/upstream.json` and `.playbook`.

## What Counts as a New Release

`watch.ts` queries the GitHub REST API (`https://api.github.com/repos/danielmiessler/LifeOS/releases/latest` and `https://api.github.com/repos/danielmiessler/LifeOS/commits/<tag>`, authenticating with `GITHUB_TOKEN` when set in the environment) and compares the result against `playbook/upstream.json`:

- If the latest upstream version is numerically lower than `upstream.json`, `watch.ts` leaves the pin alone and exits `0`.
- If the version and 40-character commit SHA match `upstream.json`, `watch.ts` reports `up to date` and exits `0`.
- If the upstream version is higher, or if the same version tag now points to a different commit SHA (upstream occasionally force-moves release tags), `watch.ts` treats it as a candidate release.

## `watch.ts` Modes

### Report Mode

```bash
bun playbook/watch.ts
```

Compares `playbook/upstream.json` with the latest upstream release on GitHub and modifies no files. Exits `0` if current (or if upstream's latest tag is older than the pin) and `10` if a newer release or moved tag is available.

### Write Candidate Mode (`--candidate-out`)

```bash
bun playbook/watch.ts --candidate-out candidate.json
```

Behaves like report mode, and when a newer release or moved tag is found, writes the candidate pin JSON to `candidate.json` before exiting `10`. If up to date, exits `0` without writing the file.

### Local Bump Check Mode (`--bump`)

```bash
bun playbook/watch.ts --bump
```

Detects a candidate release and runs the end-to-end suite on this machine's OS only, without rewriting the pin:

1. Detects whether a newer release or moved tag exists (exits `0` if none).
2. Writes the candidate pin to `playbook/.candidate-<version>.json` (or to the path given by `--candidate-out <file>`).
3. Runs `bash playbook/tests/e2e.sh --pin <candidate> --from-pin playbook/upstream.json`.
4. If `e2e.sh` fails, removes `playbook/.candidate-<version>.json` (unless `--candidate-out` was specified), leaves `playbook/upstream.json` and `.playbook` unchanged, and exits `12`.
5. If `e2e.sh` passes, keeps the candidate file, leaves `playbook/upstream.json` and `.playbook` unchanged, prints the `--apply <candidate>` command to run after the other OS passes too, and exits `10`.

Pinning requires `e2e.sh` passing on both Linux and macOS; a single-machine `--bump` covers one OS, so it never pins. Because `--bump` invokes `playbook/tests/e2e.sh`, run it only on a disposable machine or CI runner, never on a workstation.

### Apply Mode (`--apply`)

```bash
bun playbook/watch.ts --apply candidate.json
```

Reads a structurally validated candidate pin from `candidate.json`, writes it to `playbook/upstream.json`, updates the `version` line in `.playbook`, and exits `11`. `--apply` does not verify the upstream commit or test results; the caller must ensure the candidate passed testing on both Linux and macOS before applying it.

Playbook version numbering (`nextPlaybookVersion`):

- A new upstream version resets the playbook build counter to `1`: `8.761.0+pb.1` -> `8.762.0+pb.1`.
- Re-pinning the same upstream version (when a release tag moved to a new commit) increments the counter: `8.761.0+pb.1` -> `8.761.0+pb.2`.

## Exit Codes

| Exit Code | Meaning |
|---|---|
| `0` | Nothing to do (pin is already up to date, or upstream's latest release is older than the pin) |
| `1` | Error (GitHub API failure, missing `<file>` argument, invalid pin JSON, missing `version` line in `.playbook`) |
| `10` | Newer release (or moved tag) found — in report mode, `--candidate-out`, or `--bump` after `e2e.sh` passed on this OS |
| `11` | Candidate pin applied to `playbook/upstream.json` and `.playbook` (`--apply <file>`) |
| `12` | `e2e.sh` failed during `--bump`; pin left unchanged |

## The Three CI Jobs (`upstream-watch.yml`)

`.github/workflows/upstream-watch.yml` runs daily at `05:17 UTC` (`17 5 * * *`) and on `workflow_dispatch`. It separates detection, cross-platform testing, and pinning into three jobs:

1. **`detect` (`ubuntu-latest`)**:
   - Runs `bun test`.
   - Runs `bun playbook/watch.ts --candidate-out candidate.json` with `GITHUB_TOKEN`.
   - On exit `10`, exports the single-line contents of `candidate.json` as the `candidate` job output. On exit `0`, finishes cleanly with an empty output so the remaining jobs are skipped.
2. **`e2e` (`ubuntu-latest` and `macos-latest`, `if: needs.detect.outputs.candidate != ''`)**:
   - Writes the `candidate` JSON output to `$RUNNER_TEMP/candidate.json`.
   - Runs `bash playbook/tests/e2e.sh --pin "$RUNNER_TEMP/candidate.json" --from-pin playbook/upstream.json` on both Linux and macOS (`fail-fast: true`).
3. **`pin` (`ubuntu-latest`, `needs: [detect, e2e]`)**:
   - Runs only after both the Linux and macOS `e2e` matrix jobs pass, with `contents: write` and `pull-requests: write` permissions.
   - Applies the candidate with `bun playbook/watch.ts --apply "$RUNNER_TEMP/candidate.json"` and verifies exit code `11`.
   - Creates branch `claude/upstream-<version>-<commit12>`, commits `playbook/upstream.json` and `.playbook`, pushes the branch, and opens a pull request against `main` via `gh pr create`, linking the watcher run. It does not merge: the repository owner merges the pin PR (see below), then runs `cpb update <playbook>`. While that PR is open, later runs that find the same release skip it and log the PR number instead of testing it again.

## Required GitHub Repository Setting

The `pin` job uses `GITHUB_TOKEN` (`GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`, with `contents` and `pull-requests` write) to push the branch and run `gh pr create`. For this to succeed, the repository needs **Allow GitHub Actions to create and approve pull requests** (**Settings -> Actions -> General -> Workflow permissions**).

Why a person merges: `main` requires the `ci` checks on every pull request, and GitHub starts no workflow for a pull request opened with `GITHUB_TOKEN`; checks from a manually dispatched run do not count toward a ruleset's required checks either. So the pin PR shows its checks as pending. It changes only `playbook/upstream.json` and `.playbook`, and the watcher already ran the full e2e suite on Linux and macOS for it, so a repository admin merges it with the bypass. To run `ci` on it anyway, close and reopen the PR yourself: that event comes from you, so `ci` starts.
