#!/usr/bin/env bash
#
# Phase 7D.3 §2 — the documented local runtime.
#
# The live 7D.2 demonstration depended on someone remembering to start the PONS worker by
# hand. This script makes the required set explicit and supervised, with each worker in
# its own process so they have independent health, logs and restart behaviour — one
# crashed worker must not take the others down.
#
# Usage:
#   scripts/dev-stack.sh start [service...]   # default: all
#   scripts/dev-stack.sh stop  [service...]
#   scripts/dev-stack.sh status
#   scripts/dev-stack.sh logs <service>
#
# Services: api, pons, candles
#
# NOT started here, deliberately:
#   postgres  — owned by Docker/your host, see RUNBOOK.md
#   frontend  — lives in the only-pump-me repo
#   bot       — src/index.ts posts to live Discord/Telegram. Opt in explicitly with
#               `scripts/dev-stack.sh start bot`; it is never part of `start` (all).

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="${ROOT}/.run"
LOG_DIR="${RUN_DIR}/logs"
mkdir -p "${LOG_DIR}"

ALL_SERVICES=(api pons candles)

service_cmd() {
  case "$1" in
    api)     echo "npx ts-node src/researchApi/server.ts" ;;
    pons)    echo "npx ts-node src/pons/scripts/ponsWorkerMain.ts" ;;
    candles) echo "npx ts-node src/candles/scripts/candlesWorkerMain.ts" ;;
    bot)     echo "npx ts-node src/index.ts" ;;
    *)       echo "" ;;
  esac
}

# The script path each service runs, used to resolve its real pid after launch.
service_script() {
  case "$1" in
    api)     echo "src/researchApi/server.ts" ;;
    pons)    echo "src/pons/scripts/ponsWorkerMain.ts" ;;
    candles) echo "src/candles/scripts/candlesWorkerMain.ts" ;;
    bot)     echo "src/index.ts" ;;
    *)       echo "" ;;
  esac
}

pid_file() { echo "${RUN_DIR}/$1.pid"; }
log_file() { echo "${LOG_DIR}/$1.log"; }

# One-owner protection: a live PID in the pidfile means that service is already owned.
# Two PONS workers would double-poll the same blocks; two bots fight over Telegram's
# getUpdates lock and produce 409 Conflict.
is_running() {
  local pf; pf="$(pid_file "$1")"
  [[ -f "${pf}" ]] || return 1
  local pid; pid="$(cat "${pf}" 2>/dev/null)"
  [[ -n "${pid}" && -d "/proc/${pid}" ]] || return 1
  # Guard against PID reuse: the command line must still reference this repo.
  local script_path; script_path="$(service_script "$1")"
  tr '\0' ' ' < "/proc/${pid}/cmdline" 2>/dev/null | grep -q "${script_path}" || return 1
  return 0
}

start_one() {
  local svc="$1" cmd; cmd="$(service_cmd "${svc}")"
  if [[ -z "${cmd}" ]]; then echo "unknown service: ${svc}" >&2; return 1; fi

  if is_running "${svc}"; then
    echo "  ${svc}: already running (pid $(cat "$(pid_file "${svc}")"))"
    return 0
  fi

  cd "${ROOT}"
  # setsid detaches the child so it survives this shell exiting.
  setsid nohup ${cmd} >> "$(log_file "${svc}")" 2>&1 < /dev/null &
  local launcher=$!

  # `$!` is the npx wrapper, not the node process that actually holds the port. Recording
  # the wrapper let the pidfile drift: `status` reported "stopped" while a four-hour-old
  # node process still owned :8787, and every "restart" silently failed to bind and left
  # stale code serving. Resolve the real node process instead.
  local script_path; script_path="$(service_script "${svc}")"
  local pid="" i
  for i in $(seq 1 20); do
    pid="$(pgrep -f "ts-node ${script_path}" 2>/dev/null | tail -1)"
    [[ -n "${pid}" ]] && break
    sleep 0.5
  done
  [[ -z "${pid}" ]] && pid="${launcher}"

  echo "${pid}" > "$(pid_file "${svc}")"
  echo "  ${svc}: started (pid ${pid}) -> $(log_file "${svc}")"
}

# Graceful shutdown: SIGTERM, then escalate only if the process ignores it. The PONS
# worker finishes its in-flight tick and persists its checkpoint on SIGTERM, so killing
# it outright risks reprocessing a block range on next start.
stop_one() {
  local svc="$1"
  if ! is_running "${svc}"; then
    echo "  ${svc}: not running"
    rm -f "$(pid_file "${svc}")"
    return 0
  fi

  local pid; pid="$(cat "$(pid_file "${svc}")")"
  kill -TERM "${pid}" 2>/dev/null
  for _ in $(seq 1 15); do
    [[ -d "/proc/${pid}" ]] || break
    sleep 1
  done
  if [[ -d "/proc/${pid}" ]]; then
    echo "  ${svc}: did not exit on SIGTERM, sending SIGKILL (pid ${pid})"
    kill -9 "${pid}" 2>/dev/null
  else
    echo "  ${svc}: stopped cleanly (pid ${pid})"
  fi
  rm -f "$(pid_file "${svc}")"
}

status_all() {
  printf "%-10s %-10s %-8s %s\n" SERVICE STATE PID LOG
  for svc in "${ALL_SERVICES[@]}" bot; do
    if is_running "${svc}"; then
      printf "%-10s %-10s %-8s %s\n" "${svc}" running "$(cat "$(pid_file "${svc}")")" "$(log_file "${svc}")"
    else
      printf "%-10s %-10s %-8s %s\n" "${svc}" stopped - "$(log_file "${svc}")"
    fi
  done

  echo
  echo "dependencies:"
  if PGPASSWORD="${PGPASSWORD:-}" pg_isready -h localhost -p 5432 >/dev/null 2>&1; then
    echo "  postgres: reachable on localhost:5432"
  else
    echo "  postgres: NOT reachable on localhost:5432 (see RUNBOOK.md)"
  fi
  local code
  code="$(curl -s -m 3 -o /dev/null -w '%{http_code}' http://localhost:8787/api/v1/ready 2>/dev/null)"
  echo "  api readiness: ${code:-unreachable}"
}

cmd="${1:-status}"; shift || true
targets=("$@")
[[ ${#targets[@]} -eq 0 ]] && targets=("${ALL_SERVICES[@]}")

case "${cmd}" in
  start)  echo "starting:"; for s in "${targets[@]}"; do start_one "${s}"; done ;;
  stop)   echo "stopping:"; for s in "${targets[@]}"; do stop_one "${s}"; done ;;
  status) status_all ;;
  logs)   tail -f "$(log_file "${targets[0]}")" ;;
  *)      echo "usage: $0 {start|stop|status|logs} [service...]" >&2; exit 1 ;;
esac
