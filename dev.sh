#!/usr/bin/env sh
# One-command dev launcher for the LAG-4/t3code normie fork.
# Usage: ./dev.sh [commands|web|desktop|server|web-only|share|mobile|doctor|status|stop|help] [-- extra args]
# Examples:
#   ./dev.sh web                 # server + web, isolated state
#   ./dev.sh desktop              # Electron app + server
#   ./dev.sh share                # web over tailnet (phone testing)
#   ./dev.sh mobile               # Metro for the Expo dev client
#   ./dev.sh status | ./dev.sh stop
set -eu

ROOT="$(cd "$(dirname "$0")" && pwd)"
export PATH="$HOME/.local/share/vite-plus/bin:$PATH"
HOME_DIR="${T3_FORK_HOME:-/tmp/t3-fork-dev}"
RUN_DIR="/tmp/t3fork-dev"
mkdir -p "$RUN_DIR" "$HOME_DIR"

cmd="${1:-help}"
shift || true

die() { echo "dev.sh: $*" >&2; exit 1; }
need_vp() { command -v vp >/dev/null 2>&1 || die "vp not found. Install: curl -fsSL https://vite.plus | bash"; }
lane_pid() { echo "$RUN_DIR/$1.pid"; }
lane_log() { echo "$RUN_DIR/$1.log"; }

launch() {
  lane="$1"; shift
  need_vp
  if [ -f "$(lane_pid "$lane")" ] && kill -0 "$(cat "$(lane_pid "$lane")")" 2>/dev/null; then
    die "'$lane' already running (pid $(cat "$(lane_pid "$lane")")). ./dev.sh stop $lane first."
  fi
  echo "→ ./dev.sh $lane  (HOME=$HOME_DIR, log=$(lane_log "$lane"))"
  # shellcheck disable=SC2086
  nohup "$@" >"$(lane_log "$lane")" 2>&1 &
  echo $! >"$(lane_pid "$lane")"
  echo "  pid $(cat "$(lane_pid "$lane")"). Waiting for [dev-runner] ports…"
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    sleep 2
    if grep -a "\[dev-runner\]" "$(lane_log "$lane")" 2>/dev/null | head -n 1; then break; fi
  done
  grep -a -i "pairingUrl\|shared on tailnet\|Local:" "$(lane_log "$lane")" 2>/dev/null | head -n 5 || true
  echo "  full log: $(lane_log "$lane")"
}

case "$cmd" in
  web) launch web vp run dev --home-dir "$HOME_DIR" "$@" ;;
  desktop) echo "  note: first boot builds web+server, downloads Electron (~100MB), then opens a window — can take several minutes. Watch: tail -f $(lane_log desktop)"; launch desktop vp run dev:desktop --home-dir "$HOME_DIR" "$@" ;;
  server) launch server vp run dev:server --home-dir "$HOME_DIR" "$@" ;;
  web-only) launch web-only vp run dev:web --home-dir "$HOME_DIR" "$@" ;;
  share) launch share vp run dev --share --home-dir "$HOME_DIR" "$@" ;;
  mobile)
    need_vp
    echo "→ Metro dev client (run from apps/mobile). Then build the native dev client once:"
    echo "    vp run ios:dev   (from apps/mobile; needs Xcode)"
    (cd "$ROOT/apps/mobile" && exec vp run dev:client "$@")
    ;;
  doctor)
    need_vp
    echo "vp: $(vp --version)"
    echo "node: $(node --version)"
    echo "home: $HOME_DIR"
    echo "deps: $([ -d "$ROOT/node_modules" ] && echo installed || echo MISSING-run-vp-i)"
    echo "state: isolated ($HOME_DIR, live ~/.t3/userdata untouched)"
    ;;
  status)
    for l in web desktop server web-only share; do
      p="$(lane_pid "$l")"
      if [ -f "$p" ] && kill -0 "$(cat "$p")" 2>/dev/null; then
        echo "$l: running pid $(cat "$p") log $(lane_log "$l")"
      else
        echo "$l: stopped"
      fi
    done
    (lsof -i :5733 -i :13773 2>/dev/null || true) | head -n 10
    ;;
  stop)
    target="${1:-all}"
    stop_one() {
      p="$(lane_pid "$1")"
      if [ -f "$p" ]; then
        pid="$(cat "$p")"
        if kill -0 "$pid" 2>/dev/null; then kill "$pid" && echo "stopped $1 ($pid)"; else echo "$1: already dead"; fi
        rm -f "$p"
      else echo "$1: not running"; fi
    }
    if [ "$target" = "all" ]; then
      for l in web desktop server web-only share; do stop_one "$l"; done
      echo "note: if web/desktop children linger, check ./dev.sh status and kill those PIDs directly."
    else stop_one "$target"; fi
    ;;
  commands|list)
    cat <<'EOF'
Usage: ./dev.sh <command> [-- extra args passed through]

Run something:
  web         Server + web app (local dev, isolated state)
  desktop     Electron app + server
  server      Server only (no UI; pair from another client)
  web-only    Web app only (needs a server already running)
  share       Web over tailnet (test from your phone)
  mobile      Metro for the Expo dev client (then build the native client once)

Inspect / manage:
  status      Show which lanes are running (pids, logs, ports)
  stop [lane] Stop one lane, or everything (default: all)
  doctor      Sanity check: vp/node versions, deps, isolated home dir
  commands    This list
  help        Short usage header

State is isolated in /tmp/t3-fork-dev (override with T3_FORK_HOME=...).
Logs and pids live in /tmp/t3fork-dev/.
EOF
    ;;
  help|*) sed -n '2,12p' "$0"; ;;
esac
