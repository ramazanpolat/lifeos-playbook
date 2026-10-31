# Examples

Runnable command sequences ordered from a read-only dry run to the full playbook lifecycle:

- [01-plan-only](01-plan-only/README.md) -- run `convert.ts --plan` to verify prerequisites and inspect the conversion policy without changing files.
- [02-install-and-convert](02-install-and-convert/README.md) -- create the playbook with `cpb CREATE PLAYBOOK`, run `convert.ts`, and launch `/LifeOS setup`.
- [03-update-with-cpb](03-update-with-cpb/README.md) -- update an existing install in place with `cpb update lifeos` and its `playbook/bin/migrate` hook.
- [04-offline-from-a-local-checkout](04-offline-from-a-local-checkout/README.md) -- convert from a local `danielmiessler/LifeOS` directory using `--src` and `--unverified-src`.
- [05-manual-pin-bump-with-watch](05-manual-pin-bump-with-watch/README.md) -- detect, test, and apply a new upstream release with `playbook/watch.ts`.
- [06-full-lifecycle](06-full-lifecycle/README.md) -- install, convert, verify `.lifeos-playbook/state.json`, update with `cpb update`, and uninstall with `cpb DROP PLAYBOOK`.
