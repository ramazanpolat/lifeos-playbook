<!-- lifeos-playbook:bootstrap -->
# LifeOS playbook (not converted yet)

This playbook holds the converter for LifeOS (danielmiessler/LifeOS), but LifeOS itself is
not installed here yet. Conversion replaces this file with LifeOS's own CLAUDE.md.

When the user starts a session here, tell them LifeOS is not converted yet and offer:

- the plan, which changes nothing: `bun "$CLAUDE_CONFIG_DIR/playbook/convert.ts" --plan`
- the conversion, with their consent: `bun "$CLAUDE_CONFIG_DIR/playbook/convert.ts"`

After a conversion, suggest restarting the session so the new settings.json and hooks load.
