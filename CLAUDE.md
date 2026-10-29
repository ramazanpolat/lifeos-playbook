<!-- lifeos-playbook:bootstrap -->
# LifeOS playbook (not converted yet)

This playbook holds the converter for LifeOS (danielmiessler/LifeOS), but LifeOS itself is
not installed here yet. Conversion replaces this file with LifeOS's own CLAUDE.md.

When the user starts a session here, tell them LifeOS is not converted yet and offer:

- the plan, which changes nothing: `bun "$CLAUDE_CONFIG_DIR/playbook/convert.ts" --plan`
- the conversion, with their consent: `bun "$CLAUDE_CONFIG_DIR/playbook/convert.ts"`

After the converter exits 0, tell the user to restart this session (so the new settings.json, CLAUDE.md
and hooks load) and then type `/LifeOS setup`. For any other exit, explain the failure it printed and
the next step it names before suggesting a restart.
