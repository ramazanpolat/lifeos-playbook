# Offline Conversion

By default, `playbook/convert.ts` fetches the pinned upstream commit from `https://github.com/danielmiessler/LifeOS.git` into `<root>/.lifeos-playbook/staging/<commit>`. You can bypass the network fetch by pointing the converter at a local checkout of `danielmiessler/LifeOS` with `--src`.

Upstream still invokes `bun install` (`DeployCore`). Cached packages in `~/.bun` (or `~/Library/Caches/bun` on macOS) can reduce network downloads; `--src` only bypasses fetching the upstream source.

## Converting from a Verified Local Checkout (`--src`)

Pass `--src <dir>` to use an existing local git checkout of `danielmiessler/LifeOS`:

```bash
bun ~/.claude-playbooks/lifeos/playbook/convert.ts --src /home/user/src/LifeOS
```

When `--src` is provided without `--unverified-src`, `convert.ts` runs `verifyLocalSource`:

1. Runs `git -C <dir> rev-parse HEAD`. If `<dir>` is not a git repository, conversion fails (exit `1`) with:
   `--src <dir> is not a git checkout; pass --unverified-src to use it anyway`
2. Compares `HEAD` against the 40-character `commit` in `playbook/upstream.json` (or the file passed via `--pin <file>`). If they differ, conversion fails (exit `1`) with:
   `--src <dir> is at <head>, the pin says <commit>`
3. Verifies that `<dir>/<subpath>/install/install.sh`, `<dir>/<subpath>/Tools/InstallAll.ts`, and `<dir>/<subpath>/install/LIFEOS/VERSION` exist, and that `install/LIFEOS/VERSION` matches the pin's `version` field.

To check out the exact commit expected by the playbook before running `--src`:

```bash
COMMIT="$(bun -e 'console.log(require("/home/user/.claude-playbooks/lifeos/playbook/upstream.json").commit)')"
git -C /home/user/src/LifeOS checkout "$COMMIT"
bun ~/.claude-playbooks/lifeos/playbook/convert.ts --src /home/user/src/LifeOS
```

## Converting from an Unverified Directory (`--unverified-src`)

When testing an unpacked tarball, a modified working tree, or a commit that does not match `playbook/upstream.json`, combine `--src` with `--unverified-src`:

```bash
bun ~/.claude-playbooks/lifeos/playbook/convert.ts \
  --src /home/user/src/LifeOS \
  --unverified-src
```

`--unverified-src` skips the `git rev-parse HEAD` check against `pin.commit`. Note that `convert.ts` still checks that `<dir>/<subpath>/install/LIFEOS/VERSION` matches the `version` field in the active pin file (`playbook/upstream.json` or `--pin <file>`). If you are testing a different upstream version, pass a matching pin file with `--pin <file>`.

## Staging Directory Behavior with `--src`

When `--src` is used, `convert.ts` reads directly from the directory you passed and never creates or deletes `<root>/.lifeos-playbook/staging`. Your local source directory is left untouched whether the conversion succeeds or fails.
