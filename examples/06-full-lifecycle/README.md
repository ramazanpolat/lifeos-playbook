# 06: Full Lifecycle

End-to-end walkthrough of installing the playbook, converting it, verifying the audit state, updating with `cpb update`, and uninstalling with `cpb DROP PLAYBOOK`.

## 1. Install the Playbook

```bash
cpb CREATE PLAYBOOK lifeos FROM https://github.com/ramazanpolat/lifeos-playbook
```

## 2. Inspect the Plan and Convert

```bash
bun ~/.claude-playbooks/lifeos/playbook/convert.ts --plan
bun ~/.claude-playbooks/lifeos/playbook/convert.ts
```

Expected final line (exit code `0`):

```text
[convert] done: LifeOS 8.761.0 is installed in /home/user/.claude-playbooks/lifeos; start the playbook and run /LifeOS setup to begin the interview
```

## 3. Verify the Audit State

Inspect `.lifeos-playbook/state.json` and `LIFEOS/VERSION`:

```bash
cat ~/.claude-playbooks/lifeos/LIFEOS/VERSION
cat ~/.claude-playbooks/lifeos/.lifeos-playbook/state.json
```

Expected `.lifeos-playbook/state.json`:

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

Verify programmatically that `problems` is empty:

```bash
bun -e 'const s = require("/home/user/.claude-playbooks/lifeos/.lifeos-playbook/state.json"); if (s.problems.length) process.exit(1); console.log("audit ok:", s.version, s.mode);'
```

Expected output:

```text
audit ok: 8.761.0 fresh
```

## 4. Update the Playbook

When a newer pin is available in the playbook repository, update in place:

```bash
cpb update lifeos --yes
```

Verify that the migration hook ran in `upgrade` mode with 0 audit problems:

```bash
bun -e 'const s = require("/home/user/.claude-playbooks/lifeos/.lifeos-playbook/state.json"); if (s.problems.length || s.mode !== "upgrade") process.exit(1); console.log("upgrade ok:", s.from, "->", s.version);'
```

Expected output:

```text
upgrade ok: 8.761.0 -> 8.762.0
```

## 5. Uninstall the Playbook

Because LifeOS's files, hooks, skills, settings, and `user-data` live inside `/home/user/.claude-playbooks/lifeos` and no background services or shell rc edits were installed in `/home/user`, dropping the playbook removes the installation:

```bash
cpb DROP PLAYBOOK lifeos
```
