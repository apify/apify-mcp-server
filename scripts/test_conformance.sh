#!/usr/bin/env bash

set -uo pipefail

if [[ -z "${APIFY_TOKEN:-}" ]]; then
    echo "APIFY_TOKEN is not set." >&2
    exit 1
fi

export PORT="${PORT:-3001}"

run_conformance() {
    local spec_version="$1"
    local expected_failures_file="$2"

    pnpm exec conformance sdk \
        --path . \
        --mode server \
        --skip-build \
        --server-cmd "node dist/dev_server.js" \
        --server-url "http://127.0.0.1:$PORT/?token=$APIFY_TOKEN" \
        --suite all \
        --spec-version "$spec_version" \
        --expected-failures "$expected_failures_file"
}

pnpm run build || exit $?

modern_status=0
legacy_status=0
run_conformance 2026-07-28 scripts/conformance_expected_failures_2026_07_28.yaml || modern_status=$?
run_conformance 2025-11-25 scripts/conformance_expected_failures_2025_11_25.yaml || legacy_status=$?

if [[ "$modern_status" -ne 0 ]]; then
    exit "$modern_status"
fi
exit "$legacy_status"
