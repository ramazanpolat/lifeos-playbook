#!/usr/bin/env bash
# cpb -- the playbook as cpb installs and updates it: CREATE PLAYBOOK FROM a git source,
# convert, then change the source and let `cpb update` run the migrate hook.
#
#   bash playbook/tests/cpb.sh [--keep]
#
# Needs cpb (v4+) and bun on PATH. Runs under a throwaway HOME and runs upstream's
# installer, like e2e.sh: use a disposable machine.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1
command -v cpb >/dev/null || { echo "cpb.sh: cpb not on PATH" >&2; exit 2; }
command -v bun >/dev/null || { echo "cpb.sh: bun not on PATH" >&2; exit 2; }

SANDBOX="$(mktemp -d -t lifeos-cpb-XXXXXX)"
export HOME="$SANDBOX/home" TMPDIR="$SANDBOX/tmp"
mkdir -p "$HOME" "$TMPDIR"
PASS=0
FAIL=0
check() {
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then PASS=$((PASS + 1)); echo "  ok    $name"
  else FAIL=$((FAIL + 1)); echo "  FAIL  $name"; fi
}
json() { bun -e "const j=JSON.parse(require('fs').readFileSync('$1','utf8')); console.log($2)"; }
git_c() { git -C "$SRC" -c user.name=cpb-test -c user.email=cpb-test@example.invalid "$@"; }

echo "cpb.sh: sandbox $SANDBOX ($(cpb --version))"
SRC="$SANDBOX/src"
mkdir -p "$SRC"
(cd "$REPO" && git ls-files -z --cached --others --exclude-standard | xargs -0 tar cf -) | tar xf - -C "$SRC"
git -C "$SRC" init -q -b main
git_c add -A
git_c commit -q -m "playbook source"

echo "== cpb CREATE PLAYBOOK FROM the source"
ROOT="$HOME/.claude-playbooks/lifeos"
cpb CREATE PLAYBOOK lifeos FROM "file://$SRC" 2>&1 | sed 's/^/        /'
check "install: playbook root exists with the converter" test -f "$ROOT/playbook/convert.ts"
check "install: bootstrap CLAUDE.md in place" grep -q 'lifeos-playbook:bootstrap' "$ROOT/CLAUDE.md"
check "install: .playbook declares the migrate step" grep -q 'migrate = "playbook/bin/migrate"' "$ROOT/.playbook"

echo "== convert"
code=0
bun "$ROOT/playbook/convert.ts" >"$SANDBOX/convert.log" 2>&1 || code=$?
tail -n 6 "$SANDBOX/convert.log" | sed 's/^/        /'
check "convert: exits 0" test "$code" = 0
FIRST="$(json "$ROOT/.lifeos-playbook/state.json" j.converted)"

echo "== change the source, then cpb update"
sed -i.bak 's/^version = "\(.*\)+pb\.\([0-9]*\)"$/version = "\1+pb.99"/' "$SRC/.playbook" && rm -f "$SRC/.playbook.bak"
echo "cpb-test marker" >> "$SRC/README.md"
git_c commit -q -am "bump playbook version"
sleep 61 # state.json stamps minutes; make a second conversion visibly newer
code=0
cpb update lifeos --yes >"$SANDBOX/update.log" 2>&1 || code=$?
tail -n 12 "$SANDBOX/update.log" | sed 's/^/        /'
check "update: cpb update exits 0" test "$code" = 0
check "update: source change landed (README)" grep -q 'cpb-test marker' "$ROOT/README.md"
check "update: .playbook version moved to pb.99" grep -q '+pb.99"' "$ROOT/.playbook"
check "update: migrate hook re-ran the converter" test "$(json "$ROOT/.lifeos-playbook/state.json" j.converted)" != "$FIRST"
check "update: converter ran in upgrade mode" test "$(json "$ROOT/.lifeos-playbook/state.json" j.mode)" = upgrade
check "update: audit clean" test "$(json "$ROOT/.lifeos-playbook/state.json" 'j.problems.length')" = 0
check "update: CLAUDE.md kept (upstream's, not the bootstrap)" bash -c "! grep -q 'lifeos-playbook:bootstrap' '$ROOT/CLAUDE.md' && grep -q 'lifeos-playbook:begin' '$ROOT/CLAUDE.md'"
check "update: settings.json kept its data home" test "$(json "$ROOT/settings.json" j.env.LIFEOS_CONFIG_DIR)" = "$ROOT/user-data"

echo "== the per-session settings rebuild (upstream's SessionStart MergeSettings hook)"
HOOK="$(bun -e "const s=require('$ROOT/settings.json'); for (const g of s.hooks?.SessionStart ?? []) for (const h of g.hooks ?? []) if (/MergeSettings/.test(h.command)) console.log(h.command)")"
check "rebuild: hook registered" test -n "$HOOK"
code=0
(cd "$ROOT" && CLAUDE_CONFIG_DIR="$ROOT" sh -c "$HOOK") >"$SANDBOX/rebuild.log" 2>&1 || code=$?
tail -n 3 "$SANDBOX/rebuild.log" | sed 's/^/        /'
check "rebuild: hook exits 0" test "$code" = 0
check "rebuild: cpb's claudeMdExcludes survives" test "$(json "$ROOT/settings.json" '(j.claudeMdExcludes ?? []).length')" -gt 0
check "rebuild: data home still inside the root" test "$(json "$ROOT/settings.json" j.env.LIFEOS_CONFIG_DIR)" = "$ROOT/user-data"
check "rebuild: no ~/.claude paths reappear" bash -c "! grep -qE '(~|\\\$HOME)/\\.claude(/|\"|\$)' '$ROOT/settings.json'"

echo "cpb.sh: $PASS passed, $FAIL failed"
if [ "$FAIL" -eq 0 ] && [ "$KEEP" -eq 0 ]; then rm -rf "$SANDBOX"; else echo "cpb.sh: sandbox kept: $SANDBOX"; fi
[ "$FAIL" -eq 0 ]
