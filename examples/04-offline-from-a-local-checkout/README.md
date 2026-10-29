# 04: Offline Conversion from a Local Checkout

Use `--src <dir>` to convert from a local `danielmiessler/LifeOS` checkout instead of fetching from GitHub.

## Verified Checkout at the Pinned Commit

Check out the exact commit listed in `playbook/upstream.json` and pass `--src`:

```bash
git -C /home/user/src/LifeOS checkout fb9aef4640a73feae4c2e6483b26f58491ce2665
bun ~/.claude-playbooks/lifeos/playbook/convert.ts --src /home/user/src/LifeOS --plan
bun ~/.claude-playbooks/lifeos/playbook/convert.ts --src /home/user/src/LifeOS
```

### Expected Output Shape

```text
[convert] root      /home/user/.claude-playbooks/lifeos
[convert] release   danielmiessler/LifeOS 8.761.0 @ fb9aef4640a7
[convert] mode      fresh
[convert] user data /home/user/.claude-playbooks/lifeos/user-data
[convert] source    /home/user/src/LifeOS
[convert] placing the skill (release install.sh)
...
[convert] installing: components tooltips,spinnerverbs,agents,commands,workflows; declining services conduit,conduit.insight,deriver,modelsync,pulse,pulse-menubar
[convert] InstallAll (fresh): InstallSettings ok, DeployCore ok, ScaffoldUser ok, LinkUser ok, InstallHooks ok, DeployComponents ok, ActivateImports ok, RenderIdentity ok, Migrate ok, CoreServices skipped
[convert] settings.json: rebased <count> default-profile path(s)
[convert] USER tree: rebased default-profile paths in <count> file(s): <comma-separated changed paths>
[convert] user settings layer: kept cpb key(s) claudeMdExcludes across the per-session rebuild
[convert] done: LifeOS 8.761.0 is installed in /home/user/.claude-playbooks/lifeos; start the playbook and run /LifeOS setup to begin the interview
```

Exit code: `0`.

## Unverified Local Directory (`--unverified-src`)

If `/home/user/src/LifeOS` is an unpacked archive without `.git` or is checked out at a commit different from `playbook/upstream.json`, add `--unverified-src` to skip the `git rev-parse HEAD` check:

```bash
bun ~/.claude-playbooks/lifeos/playbook/convert.ts \
  --src /home/user/src/LifeOS \
  --unverified-src
```

Note that `<src>/LifeOS/install/LIFEOS/VERSION` must still match the `version` field in `playbook/upstream.json` (or the pin file passed via `--pin <file>`).
