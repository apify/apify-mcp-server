#!/usr/bin/env bash

set -uo pipefail

if [[ -z "${APIFY_TOKEN:-}" ]]; then
    echo "APIFY_TOKEN is not set." >&2
    exit 1
fi
export PORT="${PORT:-3001}"

# Runner only accepts auth via --server-url, so the token stays visible in local process args
# (ps, /proc/<pid>/cmdline) -- needs upstream header-based auth to fix. Only output is redacted here.
export ENCODED_APIFY_TOKEN
ENCODED_APIFY_TOKEN=$(node -p 'encodeURIComponent(process.env.APIFY_TOKEN)')

# Redacts raw + percent-encoded token from combined output, flushing every line so a long-running
# suite doesn't look hung. Reads via ENVIRON, not awk's -v -- -v backslash-escapes its value, so a
# token with a literal backslash would silently leak unredacted; ENVIRON also keeps it out of argv.
redact_tokens() {
    awk '
        BEGIN {
            raw = ENVIRON["APIFY_TOKEN"]
            enc = ENVIRON["ENCODED_APIFY_TOKEN"]
        }
        # Substring replace, not gsub -- gsub treats its pattern as regex, mishandling token metacharacters.
        function replace_literal(line, needle,    result, pos) {
            if (needle == "") return line
            result = ""
            while ((pos = index(line, needle)) > 0) {
                result = result substr(line, 1, pos - 1) "***REDACTED***"
                line = substr(line, pos + length(needle))
            }
            return result line
        }
        {
            line = replace_literal($0, raw)
            line = replace_literal(line, enc)
            print line
            fflush()
        }
    '
}

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
        --expected-failures "$expected_failures_file" 2>&1 | redact_tokens
    # PIPESTATUS[0]: under pipefail the pipeline's status is the rightmost nonzero code, which
    # could otherwise hide the runner's real exit behind an awk failure.
    return "${PIPESTATUS[0]}"
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
