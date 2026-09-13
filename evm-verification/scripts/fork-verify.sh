#!/usr/bin/env bash
#
# Phase 7D.3.2 §2 — run the actual-Pons fork verification suite.
#
# Exit codes are the contract with CI:
#   0   PASS     — every fork test ran against the pinned block and passed
#   1   FAIL     — the suite ran and something did not match
#   78  BLOCKED  — fork infrastructure is missing or unusable (no RPC, wrong chain, block
#                  hash disagreement, deps not installed). Never reported as a pass.
#
# RPC selection, in order: ROBINHOOD_FORK_RPC_URL, then (locally only, with --from-dotenv)
# the backend's own failover list ROBINHOOD_RPC_HTTPS → ROBINHOOD_RPC_HTTPS2 →
# DEAFULT_RPC_HTTPS. URLs are never printed; providers are referred to by variable name.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${HERE}"

FORK_BLOCK=62211539
FORK_BLOCK_HASH=0x6554d2c6d1a1b2f99b9782f9d4157c125b6d051129d859df0fdb4395751d4d25
CHAIN_ID=4663
EVIDENCE="${HERE}/evidence"

blocked() {
  echo "BLOCKED: $*" >&2
  mkdir -p "${EVIDENCE}"
  printf '{"status":"BLOCKED","reason":%s,"at":"%s"}\n' "$(printf '%s' "$*" | node -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync(0,"utf8")))')" "$(date -u +%FT%TZ)" > "${EVIDENCE}/status.json"
  exit 78
}

redact() { sed -E 's#https?://[^ "'\'']+#<redacted-url>#g'; }

rpc_json() {
  curl -s -m 20 -X POST -H 'content-type: application/json' --data "$2" "$1"
}

chain_id_of() { rpc_json "$1" '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' | node -e 'try{const j=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(j.result?String(parseInt(j.result,16)):"")}catch{}'; }

hash_at() {
  local hex h attempt; hex=$(printf '0x%x' "$2")
  for attempt in 1 2 3 4; do
    h=$(rpc_json "$1" "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getBlockByNumber\",\"params\":[\"${hex}\",false]}" | node -e 'try{const j=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(j.result?.hash||"")}catch{}')
    [ -n "$h" ] && { printf '%s' "$h"; return; }
    sleep "$attempt"
  done
}

dotenv_get() {
  [ -f "${HERE}/../.env" ] || return 0
  (cd "${HERE}/.." && node -e 'const d=require("dotenv").parse(require("fs").readFileSync(".env"));process.stdout.write(d[process.argv[1]]||"")' "$1")
}

[ -d lib/v4-periphery/.git ] || blocked "dependencies not installed; run scripts/install-deps.sh"
command -v forge >/dev/null || blocked "forge is not installed"

candidates=()
names=()
if [ -n "${ROBINHOOD_FORK_RPC_URL:-}" ]; then
  candidates+=("${ROBINHOOD_FORK_RPC_URL}"); names+=("ROBINHOOD_FORK_RPC_URL")
fi
if [ "${1:-}" = "--from-dotenv" ]; then
  for k in ROBINHOOD_RPC_HTTPS ROBINHOOD_RPC_HTTPS2 DEAFULT_RPC_HTTPS; do
    v="$(dotenv_get "$k")"
    [ -n "$v" ] && { candidates+=("$v"); names+=("$k"); }
  done
fi
[ "${#candidates[@]}" -gt 0 ] || blocked "no fork RPC configured (set ROBINHOOD_FORK_RPC_URL, or pass --from-dotenv locally)"

selected=""; selected_name=""
verified_by=()
for i in "${!candidates[@]}"; do
  url="${candidates[$i]}"; name="${names[$i]}"
  cid="$(chain_id_of "$url")"
  if [ "$cid" != "${CHAIN_ID}" ]; then
    echo "skip ${name}: chain id '${cid:-unreachable}'"
    continue
  fi
  h="$(hash_at "$url" "${FORK_BLOCK}")"
  if [ -z "$h" ]; then
    echo "skip ${name}: no archive state for block ${FORK_BLOCK}"
    continue
  fi
  if [ "${h,,}" != "${FORK_BLOCK_HASH,,}" ]; then
    blocked "${name} reports hash ${h} for block ${FORK_BLOCK}, expected ${FORK_BLOCK_HASH}"
  fi
  verified_by+=("${name}")
  [ -z "$selected" ] && { selected="$url"; selected_name="$name"; }
done
[ -n "$selected" ] || blocked "no configured RPC serves chain ${CHAIN_ID} with state at block ${FORK_BLOCK}"

echo "fork block ${FORK_BLOCK} hash ${FORK_BLOCK_HASH} confirmed by: ${verified_by[*]}"
echo "forking through ${selected_name}"

mkdir -p "${EVIDENCE}"
# Rate-limited free-tier providers drop bursts; slow, retried state loading is fine because
# Foundry caches every slot it fetches for this block.
FOUNDRY_PROFILE=fork forge test \
  --fork-url "${selected}" --fork-block-number "${FORK_BLOCK}" \
  --fork-retries 12 --fork-retry-backoff 1500 --compute-units-per-second 250 \
  --json > "${EVIDENCE}/forge-results.json" 2> >(redact >&2)
code=$?

node - "${EVIDENCE}/forge-results.json" "${selected_name}" "${verified_by[*]}" "${FORK_BLOCK}" "${FORK_BLOCK_HASH}" "$code" <<'EOF' | redact
const fs = require("fs");
const [file, provider, verifiedBy, block, hash, code] = process.argv.slice(2);
let suites = {};
try { suites = JSON.parse(fs.readFileSync(file, "utf8")); } catch { console.log("could not parse forge output"); }
let pass = 0, fail = 0; const failures = [];
for (const [suite, r] of Object.entries(suites)) {
  for (const [name, t] of Object.entries(r.test_results || {})) {
    if (t.status === "Success") pass++; else { fail++; failures.push(`${suite.split(":").pop()}.${name}: ${t.reason || t.status}`); }
  }
}
const blocked = failures.some((f) => f.includes("BLOCKED"));
const status = blocked ? "BLOCKED" : fail === 0 && pass > 0 && code === "0" ? "PASS" : "FAIL";
const out = { status, block: Number(block), blockHash: hash, forkedThrough: provider, blockHashConfirmedBy: verifiedBy.split(" "), passed: pass, failed: fail, failures, at: new Date().toISOString() };
fs.writeFileSync(require("path").join(require("path").dirname(file), "status.json"), JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(out, null, 2));
process.exitCode = status === "PASS" ? 0 : status === "BLOCKED" ? 78 : 1;
EOF
exit "${PIPESTATUS[0]}"
