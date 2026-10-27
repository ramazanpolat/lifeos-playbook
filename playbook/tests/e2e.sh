#!/usr/bin/env bash
# e2e -- convert a LifeOS release into a sandboxed playbook and check the result.
#
#   bash playbook/tests/e2e.sh [--pin <file>] [--from-pin <file>] [--keep]
#
#   --pin <file>       release to test (default: playbook/upstream.json)
#   --from-pin <file>  also test the upgrade from this release to --pin
#   --keep             keep the sandbox even when every check passes
#
# Everything runs under a throwaway HOME, so whatever the conversion writes outside
# the playbook root shows up. It runs upstream's installer: use a disposable machine
# (a throwaway VM, a CI runner), not a workstation.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PIN="$REPO/playbook/upstream.json"
FROM_PIN=""
KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --pin) PIN="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"; shift 2 ;;
    --from-pin) FROM_PIN="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    *) echo "e2e: unknown argument: $1" >&2; exit 2 ;;
  esac
done
command -v bun >/dev/null || { echo "e2e: bun not on PATH" >&2; exit 2; }

SANDBOX="$(mktemp -d -t lifeos-e2e-XXXXXX)"
export HOME="$SANDBOX/home" TMPDIR="$SANDBOX/tmp"
mkdir -p "$HOME" "$TMPDIR"
PASS=0
FAIL=0
check() { # check <name> <command...>
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then PASS=$((PASS + 1)); echo "  ok    $name"
  else FAIL=$((FAIL + 1)); echo "  FAIL  $name"; fi
}
json() { bun -e "const j=JSON.parse(require('fs').readFileSync('$1','utf8')); console.log($2)"; }
pin_version() { json "$1" "j.version"; }
sha() { if command -v sha256sum >/dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi | cut -d' ' -f1; }

# A root laid out the way `cpb CREATE PLAYBOOK ... FROM <git url>` leaves it: the tracked
# files plus their own .git.
stage_root() { # stage_root <root> <pin>
  local root="$1"
  mkdir -p "$root"
  (cd "$REPO" && git ls-files -z --cached --others --exclude-standard | xargs -0 tar cf -) | tar xf - -C "$root"
  cp "$2" "$root/playbook/upstream.json"
  git -C "$root" init -q
  git -C "$root" add -A
  git -C "$root" -c user.name=e2e -c user.email=e2e@example.invalid commit -q -m "playbook source"
}

convert() { # convert <root> <log>
  local code=0
  bun "$1/playbook/convert.ts" --root "$1" >"$2" 2>&1 || code=$?
  tail -n 25 "$2" | sed 's/^/        /'
  return $code
}

# Paths under the sandbox HOME that are not the playbook root. Package-manager caches are allowed.
outside_root() { # outside_root <root>
  find "$HOME" -mindepth 1 \( -path "$1" -o -path "$HOME/.bun" -o -path "$HOME/.cache" -o -path "$HOME/.npm" \) -prune -o -print \
    | grep -v -x -F "$HOME/.claude-playbooks" || true
}

assert_converted() { # assert_converted <root> <version> <label>
  local root="$1" v="$2" l="$3"
  check "$l: LIFEOS/VERSION is $v" test "$(tr -d '[:space:]' < "$root/LIFEOS/VERSION")" = "$v"
  check "$l: audit clean (state.json problems empty)" test "$(json "$root/.lifeos-playbook/state.json" 'j.problems.length')" = 0
  check "$l: LIFEOS/USER links into user-data" test "$(cd "$root/LIFEOS/USER" && pwd -P)" = "$(cd "$root/user-data/USER" && pwd -P)"
  check "$l: CLAUDE.md is upstream's, with one playbook section" test "$(grep -c 'lifeos-playbook:begin' "$root/CLAUDE.md")" = 1
  check "$l: bootstrap CLAUDE.md is gone" bash -c "! grep -q 'lifeos-playbook:bootstrap' '$root/CLAUDE.md'"
  check "$l: staging removed" test ! -e "$root/.lifeos-playbook/staging"
  local out; out="$(outside_root "$root")"
  check "$l: nothing written outside the root" test -z "$out"
  [ -z "$out" ] || echo "$out" | sed 's/^/        outside: /'
}

echo "e2e: sandbox $SANDBOX"
V="$(pin_version "$PIN")"

echo "== fresh install of $V"
ROOT="$HOME/.claude-playbooks/lifeos"
stage_root "$ROOT" "$PIN"
if convert "$ROOT" "$SANDBOX/fresh.log"; then check "fresh: convert exits 0" true; else check "fresh: convert exits 0" false; fi
if [ -f "$ROOT/LIFEOS/VERSION" ]; then
  assert_converted "$ROOT" "$V" "fresh"

  echo "== rerun (idempotent; InstallAll takes its upgrade chain now)"
  S1="$(sha "$ROOT/settings.json" "$ROOT/CLAUDE.md")"
  if convert "$ROOT" "$SANDBOX/rerun.log"; then check "rerun: convert exits 0" true; else check "rerun: convert exits 0" false; fi
  S2="$(sha "$ROOT/settings.json" "$ROOT/CLAUDE.md")"
  check "rerun: settings.json and CLAUDE.md unchanged" test "$S1" = "$S2"
  assert_converted "$ROOT" "$V" "rerun"

  echo "== Doctor (informational)"
  (cd "$ROOT" && CLAUDE_CONFIG_DIR="$ROOT" bun LIFEOS/TOOLS/Doctor.ts 2>&1 | tail -n 15 | sed 's/^/        /') || true
fi

if [ -n "$FROM_PIN" ] && [ "$(json "$FROM_PIN" j.commit)" = "$(json "$PIN" j.commit)" ]; then
  echo "== upgrade skipped: --from-pin is the same commit (the rerun above already exercised the upgrade chain)"
elif [ -n "$FROM_PIN" ]; then
  FV="$(pin_version "$FROM_PIN")"
  echo "== upgrade $FV -> $V"
  UP="$HOME/.claude-playbooks/lifeos-upgrade"
  stage_root "$UP" "$FROM_PIN"
  if convert "$UP" "$SANDBOX/upgrade-from.log"; then
    check "upgrade: $FV converts" true
    echo "e2e marker" > "$UP/user-data/USER/e2e-marker.txt"
    cp "$PIN" "$UP/playbook/upstream.json"
    if convert "$UP" "$SANDBOX/upgrade-to.log"; then check "upgrade: convert to $V exits 0" true; else check "upgrade: convert to $V exits 0" false; fi
    check "upgrade: ran in upgrade mode" test "$(json "$UP/.lifeos-playbook/state.json" j.mode)" = upgrade
    check "upgrade: user data survived" test -f "$UP/user-data/USER/e2e-marker.txt"
    assert_converted "$UP" "$V" "upgrade"
  else
    check "upgrade: $FV converts" false
  fi
fi

echo "e2e: $PASS passed, $FAIL failed"
if [ "$FAIL" -eq 0 ] && [ "$KEEP" -eq 0 ]; then rm -rf "$SANDBOX"; else echo "e2e: sandbox kept: $SANDBOX"; fi
[ "$FAIL" -eq 0 ]
