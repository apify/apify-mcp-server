#!/usr/bin/env bash

set -uo pipefail

if [[ -z "${APIFY_TOKEN:-}" ]]; then
    echo "APIFY_TOKEN is not set." >&2
    exit 1
fi
export PORT="${PORT:-3001}"

# The conformance runner accepts the token only via --server-url, so it stays visible in local
# process arguments (ps, /proc/<pid>/cmdline). Fixing that needs header-based auth support in
# the upstream conformance runner; only terminal output is redacted here.
export ENCODED_APIFY_TOKEN
ENCODED_APIFY_TOKEN=$(node -p 'encodeURIComponent(process.env.APIFY_TOKEN)')

# Redacts both the raw and percent-encoded token from a command's combined output. Line-buffered
# via fflush() so a long-running suite doesn't look hung; awk (not sed -u/-l) behaves the same on
# GNU (CI) and BSD (local macOS) since the unbuffering flags differ between the two. Reads the
# token via ENVIRON rather than -v: awk's -v assignment runs backslash-escape processing (POSIX),
# so a token containing a literal backslash would silently fail to match and leak unredacted;
# ENVIRON values aren't escape-processed. This also keeps the token out of awk's own argv.
redact_tokens() {
    awk '
        BEGIN {
            raw = ENVIRON["APIFY_TOKEN"]
            enc = ENVIRON["ENCODED_APIFY_TOKEN"]
        }
        # Plain substring replacement (not gsub, which treats its pattern as a regex and would
        # mishandle a token containing regex metacharacters).
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
    # Capture the conformance runner's own exit code explicitly: under pipefail, the pipeline's
    # status is the rightmost nonzero exit code, so a redact_tokens/awk failure could otherwise
    # mask the runner's real status.
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
