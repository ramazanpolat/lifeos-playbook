# 02: Install and Convert

Create the `lifeos` playbook from the repository, convert the pinned upstream LifeOS release, and start the initial setup interview.

## Commands

```bash
cpb CREATE PLAYBOOK lifeos FROM https://github.com/ramazanpolat/lifeos-playbook
bun ~/.claude-playbooks/lifeos/playbook/convert.ts
```

## Expected Output Shape

```text
[convert] root      /home/user/.claude-playbooks/lifeos
[convert] release   danielmiessler/LifeOS 8.761.0 @ fb9aef4640a7
[convert] mode      fresh
[convert] user data /home/user/.claude-playbooks/lifeos/user-data
[convert] source    fetch github.com/danielmiessler/LifeOS fb9aef4640a73feae4c2e6483b26f58491ce2665
[convert] fetching the pinned commit
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

## First Launch

```bash
lifeos
```

Then inside the Claude Code session:

```text
/LifeOS setup
```
