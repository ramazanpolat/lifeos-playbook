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

# Resolved: on macOS the temp dir is reached through a symlink (/var -> /private/var).
SANDBOX="$(cd "$(mktemp -d -t lifeos-e2e-XXXXXX)" && pwd -P)"
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
# settings.json by meaning: keys sorted, so a rewrite in another key order counts as unchanged.
canon() { bun -e "const s=(v)=>Array.isArray(v)?v.map(s):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,s(v[k])])):v; console.log(JSON.stringify(s(JSON.parse(require('fs').readFileSync('$1','utf8')))))"; }
# Key paths whose values differ between two JSON files (for a failing idempotency check).
json_diff() { bun -e "
  const fs=require('fs'), a=JSON.parse(fs.readFileSync('$1','utf8')), b=JSON.parse(fs.readFileSync('$2','utf8'));
  const walk=(x,y,p)=>{ if (JSON.stringify(x)===JSON.stringify(y)) return; if (x&&y&&typeof x==='object'&&typeof y==='object'&&!Array.isArray(x)&&!Array.isArray(y)) { for (const k of new Set([...Object.keys(x),...Object.keys(y)])) walk(x[k],y[k],p+'.'+k); } else console.log('        changed: '+p+': '+JSON.stringify(x)?.slice(0,80)+' -> '+JSON.stringify(y)?.slice(0,80)); };
  walk(a,b,'settings');"; }

# Run the SessionStart settings rebuild (SettingsBackport; MergeSettings) as Claude Code would.
session_rebuild() { # session_rebuild <root>
  local hook
  hook="$(bun -e "const s=require('$1/settings.json'); for (const g of s.hooks?.SessionStart ?? []) for (const h of g.hooks ?? []) if (/MergeSettings/.test(h.command)) console.log(h.command)")"
  [ -n "$hook" ] && (cd "$1" && CLAUDE_CONFIG_DIR="$1" sh -c "$hook") >/dev/null 2>&1
}

# Where upstream's own resolver puts the USER tree, with a decoy LifeOS in a default profile.
resolve_user_dir() { # resolve_user_dir <root>
  local decoy="$SANDBOX/decoy-home"
  mkdir -p "$decoy/.claude/LIFEOS/USER/CONFIG"
  sed "s|^user_dir = .*|user_dir = \"$decoy/.claude/LIFEOS/USER\"|" "$1/user-data/USER/CONFIG/LIFEOS_CONFIG.toml" > "$decoy/.claude/LIFEOS/USER/CONFIG/LIFEOS_CONFIG.toml"
  (cd "$1" && HOME="$decoy" bun -e "
    const s = require('$1/settings.json');
    Object.assign(process.env, s.env ?? {}, { CLAUDE_CONFIG_DIR: '$1' });
    const { lifeosUserDir } = await import('$1/LIFEOS/TOOLS/LifeosConfig.ts');
    console.log(lifeosUserDir());")
}

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

# Paths under the sandbox HOME that are not the playbook root. Allowed: package-manager caches
# (bun and node-gyp: ~/.bun and ~/.cache on Linux, ~/Library/Caches on macOS) and upstream's
# per-user runtime state in ~/.local/state/lifeos, which ~20 upstream call sites hard-code
# (reported by known_outside, not hidden).
outside_root() { # outside_root <root>
  find "$HOME" -mindepth 1 \( -path "$1" -o -path "$HOME/.bun" -o -path "$HOME/.cache" -o -path "$HOME/.npm" \
      -o -path "$HOME/Library/Caches/bun" -o -path "$HOME/Library/Caches/node-gyp" -o -path "$HOME/.local/state/lifeos" \) -prune -o -print \
    | grep -v -x -F -e "$HOME/.claude-playbooks" -e "$HOME/Library" -e "$HOME/Library/Caches" -e "$HOME/.local" -e "$HOME/.local/state" || true
}
known_outside() { # what upstream wrote to its per-user runtime state, for the record
  [ -d "$HOME/.local/state/lifeos" ] && echo "        note: upstream runtime state in ~/.local/state/lifeos: $(cd "$HOME/.local/state/lifeos" && ls | tr '\n' ' ')"
  return 0
}

assert_converted() { # assert_converted <root> <version> <label>
  local root="$1" v="$2" l="$3"
  check "$l: LIFEOS/VERSION is $v" test "$(tr -d '[:space:]' < "$root/LIFEOS/VERSION")" = "$v"
  check "$l: audit clean (state.json problems empty)" test "$(json "$root/.lifeos-playbook/state.json" 'j.problems.length')" = 0
  check "$l: LIFEOS/USER links into user-data" test "$(cd "$root/LIFEOS/USER" && pwd -P)" = "$(cd "$root/user-data/USER" && pwd -P)"
  check "$l: CLAUDE.md is upstream's, with one playbook section" test "$(grep -c 'lifeos-playbook:begin' "$root/CLAUDE.md")" = 1
  check "$l: bootstrap CLAUDE.md is gone" bash -c "! grep -q 'lifeos-playbook:bootstrap' '$root/CLAUDE.md'"
  check "$l: staging removed" test ! -e "$root/.lifeos-playbook/staging"
  check "$l: USER skill configs carry no ~/.claude path" bash -c "! grep -lE '(~|\\\$HOME)/\\.claude(/|\\b)' '$root'/user-data/USER/CUSTOMIZATIONS/SKILLS/*/Config.md"
  local out; out="$(outside_root "$root")"
  check "$l: nothing written outside the root" test -z "$out"
  [ -z "$out" ] || echo "$out" | sed 's/^/        outside: /'
  known_outside
}

echo "e2e: sandbox $SANDBOX"
V="$(pin_version "$PIN")"

echo "== fresh install of $V"
ROOT="$HOME/.claude-playbooks/lifeos"
stage_root "$ROOT" "$PIN"
FRESH_OK=0
if convert "$ROOT" "$SANDBOX/fresh.log"; then FRESH_OK=1; check "fresh: convert exits 0" true; else check "fresh: convert exits 0" false; fi
if [ "$FRESH_OK" -eq 1 ]; then
  assert_converted "$ROOT" "$V" "fresh"

  echo "== hooks (every registered hook fired with a synthetic Claude Code event)"
  hcode=0
  bun "$ROOT/playbook/tests/hook-smoke.ts" --root "$ROOT" >"$SANDBOX/hooks.log" 2>&1 || hcode=$?
  grep -vE '^  ok ' "$SANDBOX/hooks.log" | sed 's/^/        /'
  check "fresh: every command hook exits 0 and the expected ones are registered" test "$hcode" = 0
  RESOLVED="$(resolve_user_dir "$ROOT")"
  echo "        LifeOS resolves its USER tree to: ${RESOLVED/#$SANDBOX/<sandbox>}"
  check "fresh: LifeOS reads its own config, not a default-profile LifeOS" bash -c "[[ '$RESOLVED' == '$ROOT'/* ]]"

  echo "== a user's own changes: a settings.json edit and CLAUDE.local.md"
  # A hand edit, and the shipped statusline switched on (an upgrade must not schedule its machine-wide refresher job).
  bun -e "const f='$ROOT/settings.json', fs=require('fs'), s=JSON.parse(fs.readFileSync(f,'utf8')); s.env.E2E_USER_SETTING='kept'; s.statusLine={type:'command', command:'$ROOT/LIFEOS/LIFEOS_StatusLine.sh'}; fs.writeFileSync(f, JSON.stringify(s,null,2)+'\n')"
  echo "e2e personal instruction" > "$ROOT/CLAUDE.local.md"
  session_rebuild "$ROOT"

  echo "== rerun (idempotent; InstallAll takes its upgrade chain now)"
  S1="$(canon "$ROOT/settings.json")"; C1="$(sha "$ROOT/CLAUDE.md")"; cp "$ROOT/settings.json" "$SANDBOX/settings.before-rerun.json"
  if convert "$ROOT" "$SANDBOX/rerun.log"; then check "rerun: convert exits 0" true; else check "rerun: convert exits 0" false; fi
  S2="$(canon "$ROOT/settings.json")"; C2="$(sha "$ROOT/CLAUDE.md")"
  check "rerun: settings.json unchanged in meaning" test "$S1" = "$S2"
  [ "$S1" = "$S2" ] || json_diff "$SANDBOX/settings.before-rerun.json" "$ROOT/settings.json"
  check "rerun: CLAUDE.md unchanged" test "$C1" = "$C2"
  assert_converted "$ROOT" "$V" "rerun"
  session_rebuild "$ROOT"
  check "rerun: the settings edit survives the first rebuild after an upgrade" test "$(json "$ROOT/settings.json" 'j.env.E2E_USER_SETTING')" = kept
  check "rerun: the statusline is still configured" bash -c "grep -q 'LIFEOS_StatusLine.sh' '$ROOT/settings.json'"
  check "rerun: CLAUDE.local.md untouched" test "$(cat "$ROOT/CLAUDE.local.md")" = "e2e personal instruction"
  check "rerun: CLAUDE.md still imports CLAUDE.local.md" grep -qx '@CLAUDE.local.md' "$ROOT/CLAUDE.md"
  check "rerun: LifeOS still reads its own config" bash -c "[[ '$(resolve_user_dir "$ROOT")' == '$ROOT'/* ]]"

  echo "== convert --check (pin, isolation, USER resolution, upstream Doctor with the playbook's env)"
  ccode=0
  bun "$ROOT/playbook/convert.ts" --check >"$SANDBOX/check.log" 2>&1 || ccode=$?
  sed 's/^/        /' "$SANDBOX/check.log" | grep -v '^        \[check\]   ✅' | head -30
  check "check: healthy" test "$ccode" = 0
  check "check: Doctor no longer misreports the USER links" bash -c "! grep -q 'USER-data mounts.*broken' '$SANDBOX/check.log'"
  # The same playbook reached through a symlink must check out the same (macOS /var -> /private/var).
  ln -s "$ROOT" "$SANDBOX/linked-playbook"
  lcode=0
  bun "$SANDBOX/linked-playbook/playbook/convert.ts" --check >"$SANDBOX/check-linked.log" 2>&1 || lcode=$?
  check "check: healthy through a symlinked path too" test "$lcode" = 0
  [ "$lcode" = 0 ] || grep -E 'problem|  - ' "$SANDBOX/check-linked.log" | head -5 | sed 's/^/        /'
  rm -f "$SANDBOX/linked-playbook"
fi

if [ -n "$FROM_PIN" ] && [ "$(json "$FROM_PIN" j.commit)" = "$(json "$PIN" j.commit)" ]; then
  echo "== upgrade skipped: --from-pin is the same commit (the rerun above already exercised the upgrade chain)"
elif [ -n "$FROM_PIN" ]; then
  FV="$(pin_version "$FROM_PIN")"
  echo "== upgrade $FV -> $V"
  # A HOME of its own: the fresh install above would otherwise count as an outside-root write.
  export HOME="$SANDBOX/home-upgrade"
  mkdir -p "$HOME"
  UP="$HOME/.claude-playbooks/lifeos"
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
