#!/usr/bin/env bash
#
# Phase 7D.3.2 §2 — install the Solidity dependencies at pinned commits.
#
# `forge install` without a lockfile resolves to whatever `main` is today, which is how the
# earlier harness ended up compiling against an unrecorded v4-periphery. Everything here is
# pinned by full commit SHA and checked after checkout, so a CI run and a laptop run
# compile identical sources.
#
# v4-periphery 6601a199 is not an arbitrary choice: its V4Quoter sources are byte-identical
# to the Blockscout-verified sources of the official Robinhood Chain quoter
# (0x8dc178efb8111bb0973dd9d722ebeff267c98f94), and compiling it with Uniswap's release
# settings reproduces that contract's runtime bytecode exactly. See
# docs/phase-7d3-2-quote-verification.md §2.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIB="${HERE}/lib"

V4_PERIPHERY_REPO="https://github.com/Uniswap/v4-periphery.git"
V4_PERIPHERY_COMMIT="6601a199799294378f4df9819e6641b2391ef3c5"
# The v4-core submodule recorded by that periphery commit. Checked rather than trusted.
V4_CORE_COMMIT="59d3ecf53afa9264a16bba0e38f4c5d2231f80bc"

mkdir -p "${LIB}"

checkout_pinned() {
  local dir="$1" repo="$2" commit="$3"
  if [ -d "${dir}/.git" ] && [ "$(git -C "${dir}" rev-parse HEAD)" = "${commit}" ]; then
    echo "ok: ${dir##*/} already at ${commit}"
  else
    rm -rf "${dir}"
    git clone --quiet --filter=blob:none "${repo}" "${dir}"
    git -C "${dir}" -c advice.detachedHead=false checkout --quiet "${commit}"
  fi
  git -C "${dir}" submodule update --init --recursive --quiet
}

checkout_pinned "${LIB}/v4-periphery" "${V4_PERIPHERY_REPO}" "${V4_PERIPHERY_COMMIT}"

actual_core="$(git -C "${LIB}/v4-periphery/lib/v4-core" rev-parse HEAD)"
if [ "${actual_core}" != "${V4_CORE_COMMIT}" ]; then
  echo "error: v4-core is ${actual_core}, expected ${V4_CORE_COMMIT}" >&2
  exit 1
fi

echo "v4-periphery ${V4_PERIPHERY_COMMIT}"
echo "v4-core      ${actual_core}"
