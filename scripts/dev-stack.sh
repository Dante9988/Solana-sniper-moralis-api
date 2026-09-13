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

# Port each service is expected to own, used to detect conflicts and confirm readiness.
service_port() {
  case "$1" in
    api) echo "8787" ;;
    *)   echo "" ;;
  esac
}

# Every live pid for a service, matched on this repo's path plus the service script, so
# another checkout of the same repo is never touched.
service_pids() {
  local script_path; script_path="$(service_script "$1")"
  [[ -z "${script_path}" ]] && return 0
  local pid cmdline
  for pid in $(pgrep -f "ts-node" 2>/dev/null); do
    [[ -d "/proc/${pid}" ]] || continue
    cmdline="$(tr '\0' ' ' < "/proc/${pid}/cmdline" 2>/dev/null)"
    [[ "${cmdline}" == *"${script_path}"* ]] || continue
    # Scope to THIS checkout: the resolved cwd must be this repo.
    [[ "$(readlink -f "/proc/${pid}/cwd" 2>/dev/null)" == "${ROOT}" ]] || continue
    echo "${pid}"
  done
}

# pid currently listening on a port, empty when free.
port_owner() {
  local owner
  owner="$(ss -ltnp 2>/dev/null | grep -oE ":$1 .*pid=[0-9]+" | grep -oE "pid=[0-9]+" | head -1 | cut -d= -f2)"
  [[ -n "${owner}" ]] && echo "${owner}"
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

  local script_path; script_path="$(service_script "${svc}")"

  # Refuse to start on top of an orphan. Two bugs bit us here: `$!` is the npx wrapper
  # rather than the node process holding the port, and a naive pgrep after launch can
  # match a *pre-existing* orphan instead of the child just spawned — which silently
  # adopted a 98-minute-old process running stale code and reported it as "started".
  local pre_existing; pre_existing="$(service_pids "${svc}")"
  if [[ -n "${pre_existing}" ]]; then
    echo "  ${svc}: refusing to start — untracked process(es) already running: ${pre_existing//$'\n'/ }" >&2
    echo "  ${svc}: run '$0 stop ${svc}' first (it reaps untracked processes too)" >&2
    return 1
  fi

  local port; port="$(service_port "${svc}")"
  if [[ -n "${port}" ]] && port_owner "${port}" >/dev/null; then
    echo "  ${svc}: refusing to start — port ${port} is already held by pid $(port_owner "${port}")" >&2
    return 1
  fi

  cd "${ROOT}"
  # setsid detaches the child so it survives this shell exiting.
  setsid nohup ${cmd} >> "$(log_file "${svc}")" 2>&1 < /dev/null &
  local launcher=$!

  # Identify the process that appeared *after* launch, not any that matches the pattern.
  local pid="" i
  for i in $(seq 1 30); do
    pid="$(service_pids "${svc}" | head -1)"
    [[ -n "${pid}" ]] && break
    sleep 0.5
  done
  [[ -z "${pid}" ]] && pid="${launcher}"

  echo "${pid}" > "$(pid_file "${svc}")"

  # Confirm readiness, and let the port decide which pid is authoritative.
  #
  # `npx ts-node` spawns a child that actually binds the socket, so the first matching
  # process is often the parent wrapper rather than the listener. For a service with a
  # port, the process holding that port IS the service — record that one, after checking
  # it belongs to this checkout.
  if [[ -n "${port}" ]]; then
    local owner=""
    for i in $(seq 1 40); do
      owner="$(port_owner "${port}")"
      [[ -n "${owner}" ]] && break
      sleep 0.5
    done
    if [[ -z "${owner}" ]]; then
      echo "  ${svc}: started (pid ${pid}) but nothing is listening on ${port} — NOT ready" >&2
      return 1
    fi
    if [[ "$(readlink -f "/proc/${owner}/cwd" 2>/dev/null)" != "${ROOT}" ]]; then
      echo "  ${svc}: port ${port} is held by pid ${owner} from a different checkout — NOT ready" >&2
      return 1
    fi
    pid="${owner}"
    echo "${pid}" > "$(pid_file "${svc}")"
  fi

  echo "  ${svc}: started (pid ${pid}) -> $(log_file "${svc}")"
}

# Graceful shutdown: SIGTERM, then escalate only if the process ignores it. The PONS
# worker finishes its in-flight tick and persists its checkpoint on SIGTERM, so killing
# it outright risks reprocessing a block range on next start.
stop_one() {
  local svc="$1"

  # Reap untracked processes for this service too — orphans from a failed start are how
  # stale code kept serving while the pidfile said "stopped".
  local orphan
  for orphan in $(service_pids "${svc}"); do
    [[ "${orphan}" == "$(cat "$(pid_file "${svc}")" 2>/dev/null)" ]] && continue
    echo "  ${svc}: reaping untracked pid ${orphan}"
    kill -TERM "${orphan}" 2>/dev/null
  done

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
