#!/usr/bin/env bash
# journey -- the whole user journey on a throwaway machine, as that machine's own user:
# prerequisites, cpb install, the plan, the mistake of converting without a toolchain,
# the conversion, hooks, a rerun, a held lock, an interrupted run, cpb update, uninstall.
# Every command and its output lands in a transcript for UX review.
#
#   bash playbook/tests/journey.sh --source <git url or file:// path> [--branch <b>] [--transcript <file>]
#
# It changes the machine's real HOME (installs bun and cpb, creates and drops a playbook) and
# runs upstream's installer: use a disposable VM (for example a fresh clone), never a workstation.
set -uo pipefail

SOURCE=""
BRANCH=""
TRANSCRIPT="$PWD/journey-transcript.txt"
NAME="lifeos"
while [ $# -gt 0 ]; do
  case "$1" in
    --source) SOURCE="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    --transcript) TRANSCRIPT="$2"; shift 2 ;;
    *) echo "journey: unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$SOURCE" ] || { echo "journey: --source is required" >&2; exit 2; }
: > "$TRANSCRIPT"

BUN_VERSION=1.3.13
CPB_VERSION=v4.1.0
ROOT="$HOME/.claude-playbooks/$NAME"
PASS=0
FAIL=0
SUMMARY=()
say() { echo "$*" | tee -a "$TRANSCRIPT"; }
step() { say ""; say "######## $*"; }
# run <label> <expected-exit|any> <command...>: echo the command, tee its output, time it, check the exit code.
run() {
  local label="$1" want="$2"; shift 2
  say "\$ $*"
  local t0=$SECONDS code
  "$@" > >(tee -a "$TRANSCRIPT") 2>&1
  code=$?
  local dt=$((SECONDS - t0))
  if [ "$want" = any ] || [ "$code" = "$want" ]; then
    PASS=$((PASS + 1)); SUMMARY+=("ok    ${dt}s  $label (exit $code)")
  else
    FAIL=$((FAIL + 1)); SUMMARY+=("FAIL  ${dt}s  $label (exit $code, wanted $want)")
  fi
  say "[exit $code, ${dt}s]"
  return 0
}
check() { # check <label> <command...>
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then PASS=$((PASS + 1)); SUMMARY+=("ok          $label")
  else FAIL=$((FAIL + 1)); SUMMARY+=("FAIL        $label"); fi
}
state() { bun -e "console.log(JSON.parse(require('fs').readFileSync('$ROOT/.lifeos-playbook/state.json','utf8'))$1)"; }

step "0. machine"
say "$(uname -srm); user $(id -un); claude: $(claude --version 2>/dev/null || echo none)"
say "claude login on this machine: $(test -f "$HOME/.claude/.credentials.json" && echo present || echo absent or parked)"

step "1. prerequisites, as README.md lists them (bun 1.2+, git; on Linux make and g++)"
if ! command -v bun >/dev/null; then
  say "bun not installed: installing $BUN_VERSION from its release archive into ~/.bun/bin"
  arch=$(uname -m); [ "$arch" = aarch64 ] && arch=aarch64 || arch=x64
  os=$(uname -s | tr '[:upper:]' '[:lower:]'); [ "$os" = darwin ] && os=darwin
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/bun.zip" "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/bun-$os-$arch.zip" \
    && python3 -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "$tmp/bun.zip" "$tmp" \
    && mkdir -p "$HOME/.bun/bin" && install -m 755 "$tmp/bun-$os-$arch/bun" "$HOME/.bun/bin/bun"
  rm -rf "$tmp"
fi
if ! command -v cpb >/dev/null; then
  say "cpb not installed: installing $CPB_VERSION from its release into ~/.local/bin (checksum verified)"
  tmp=$(mktemp -d); a=$( [ "$(uname -m)" = aarch64 ] && echo arm64 || echo amd64 ); o=$(uname -s | tr '[:upper:]' '[:lower:]')
  (cd "$tmp" && curl -fsSLO "https://github.com/ramazanpolat/claude-playbooks/releases/download/$CPB_VERSION/cpb-$o-$a" \
    && curl -fsSLO "https://github.com/ramazanpolat/claude-playbooks/releases/download/$CPB_VERSION/SHA256SUMS" \
    && grep " cpb-$o-$a$" SHA256SUMS | sha256sum -c - >/dev/null) \
    && mkdir -p "$HOME/.local/bin" && install -m 755 "$tmp/cpb-$o-$a" "$HOME/.local/bin/cpb"
  rm -rf "$tmp"
fi
say "on PATH in a fresh login shell: bun=$(bash -lc 'command -v bun' 2>/dev/null || echo NO) cpb=$(bash -lc 'command -v cpb' 2>/dev/null || echo NO)"
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
run "bun --version" 0 bun --version
run "cpb --version" 0 cpb --version
check "git present" command -v git

step "2. install the playbook with cpb"
if [ -n "$BRANCH" ]; then run "cpb CREATE PLAYBOOK" 0 cpb CREATE PLAYBOOK "$NAME" FROM "$SOURCE" BRANCH "$BRANCH"
else run "cpb CREATE PLAYBOOK" 0 cpb CREATE PLAYBOOK "$NAME" FROM "$SOURCE"; fi
check "playbook root exists" test -f "$ROOT/playbook/convert.ts"
say "launcher on PATH: $(command -v "$NAME" || echo NO)"
run "cpb SHOW PLAYBOOK" any cpb SHOW PLAYBOOK "$NAME"

step "3. what a user sees if they launch before converting (the bootstrap CLAUDE.md)"
run "bootstrap CLAUDE.md" 0 cat "$ROOT/CLAUDE.md"

step "4. the plan"
if [ "$(uname -s)" = Linux ] && ! command -v make >/dev/null; then
  run "convert --plan names the missing toolchain (not ready)" 2 bun "$ROOT/playbook/convert.ts" --plan
  check "the plan was still printed" grep -q "plan only: components" "$TRANSCRIPT"
else
  run "convert --plan (ready)" 0 bun "$ROOT/playbook/convert.ts" --plan
fi

if [ "$(uname -s)" = Linux ] && ! command -v make >/dev/null; then
  step "5. converting before installing the Linux toolchain (a likely first mistake)"
  run "convert without make/g++ is refused" 2 bun "$ROOT/playbook/convert.ts"
  step "6. install the toolchain the refusal names"
  run "apt-get install build-essential" 0 sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq build-essential
fi

step "7. convert"
run "convert (fresh)" 0 bun "$ROOT/playbook/convert.ts"
check "audit clean" test "$(state '.problems.length')" = 0
check "LIFEOS/VERSION matches the pin" test "$(tr -d '[:space:]' < "$ROOT/LIFEOS/VERSION")" = "$(bun -e "console.log(require('$ROOT/playbook/upstream.json').version)")"

step "8. does it work: Doctor, then every registered hook fired with a synthetic event"
run "Doctor" any bash -c "cd '$ROOT' && CLAUDE_CONFIG_DIR='$ROOT' bun LIFEOS/TOOLS/Doctor.ts"
run "hook smoke" 0 bun "$ROOT/playbook/tests/hook-smoke.ts" --root "$ROOT"

step "9. rerun (idempotent)"
run "convert (rerun)" 0 bun "$ROOT/playbook/convert.ts"

step "10. two conversions at once"
bun "$ROOT/playbook/convert.ts" > /tmp/journey-first.log 2>&1 &
first=$!
for _ in $(seq 1 50); do [ -f "$ROOT/.lifeos-playbook/convert.lock" ] && break; sleep 0.2; done
run "second conversion is refused while the first runs" 2 bun "$ROOT/playbook/convert.ts"
wait "$first"; check "first conversion still finished" test $? = 0

step "11. interrupted conversion, then rerun"
# Ctrl-C signals the whole foreground process group, upstream's child processes included.
setsid bun "$ROOT/playbook/convert.ts" > /tmp/journey-interrupted.log 2>&1 &
victim=$!
sleep 6; kill -INT -- "-$victim" 2>/dev/null; wait "$victim" 2>/dev/null
sleep 2
say "interrupted after 6s (process group); last lines:"; tail -n 3 /tmp/journey-interrupted.log | tee -a "$TRANSCRIPT"
run "convert after the interruption" 0 bun "$ROOT/playbook/convert.ts"
check "audit clean after recovery" test "$(state '.problems.length')" = 0

step "12. update: the source moves on, cpb update runs the converter"
if [[ "$SOURCE" == file://* ]]; then
  src="${SOURCE#file://}"
  sed -i.bak 's/^version = "\(.*\)+pb\.\([0-9]*\)"$/version = "\1+pb.99"/' "$src/.playbook" && rm -f "$src/.playbook.bak"
  git -C "$src" -c user.name=journey -c user.email=journey@example.invalid commit -qam "journey: bump playbook version"
  before="$(state '.converted')"; sleep 61
  run "cpb update" 0 cpb update "$NAME" --yes
  check "update re-ran the converter" test "$(state '.converted')" != "$before"
  check "update converted in upgrade mode" test "$(state '.mode')" = upgrade
  run "hook smoke after update" 0 bun "$ROOT/playbook/tests/hook-smoke.ts" --root "$ROOT"
else
  say "skipped: the source is not a local git checkout this script may commit to"
fi

step "13. uninstall"
run "cpb DROP PLAYBOOK" 0 cpb DROP PLAYBOOK "$NAME" --yes
check "playbook root removed" test ! -e "$ROOT"
check "launcher removed" bash -c "! command -v $NAME"
check "no LifeOS data home left in ~/.config" test ! -e "$HOME/.config/LIFEOS"
check "no LifeOS systemd user units" bash -c "! ls $HOME/.config/systemd/user 2>/dev/null | grep -qi lifeos"
check "no LifeOS crontab entries" bash -c "! crontab -l 2>/dev/null | grep -qi lifeos"

step "summary"
for s in "${SUMMARY[@]}"; do say "  $s"; done
say "journey: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
