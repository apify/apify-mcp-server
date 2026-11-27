#!/usr/bin/env bash
# Runs MCPJam's MCP Apps conformance checks (`mcpjam apps conformance`) against the widget tools
# and `ui://` resources, on stdio and on the HTTP dev server in both protocol eras. The official
# runner in test_conformance.sh has no MCP Apps scenarios.

set -uo pipefail

if [[ -z "${APIFY_TOKEN:-}" ]]; then
    echo "APIFY_TOKEN is not set." >&2
    exit 1
fi
PORT="${PORT:-3001}"

# Run through dlx, not as a devDependency: the CLI installs ~140 MB, mostly AI SDK providers.
MCPJAM_CLI="@mcpjam/cli@6.3.2"
# The default tool set serves only two of the four widget tools.
WIDGET_TOOLS="call-actor-widget,get-actor-run-widget,search-actors-widget,fetch-actor-details-widget"
EXPECTED_CHECKS="ui-tools-present ui-tool-metadata-valid ui-tool-input-schema-valid ui-listed-resources-valid ui-resources-readable ui-resource-contents-valid ui-resource-meta-valid"

source "$(dirname "$0")/redact_tokens.sh"

REPORT_DIR=$(mktemp -d)
SERVER_PID=""
cleanup() {
    if [[ -n "$SERVER_PID" ]]; then
        kill "$SERVER_PID" 2>/dev/null
    fi
    rm -rf "$REPORT_DIR"
}
trap cleanup EXIT

# Fails unless every expected check reports `passed`. The CLI's exit code and `outcome` are not
# enough: when the server serves no UI tool, every check is `skipped` and the CLI still exits 0
# with `outcome: passed`.
check_report() {
    EXPECTED_CHECKS="$EXPECTED_CHECKS" node -e '
        const fs = require("node:fs");
        let report;
        try {
            report = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        } catch (error) {
            console.error(`Cannot read the json-summary report: ${error.message}`);
            process.exit(1);
        }
        const statuses = new Map(report.groups.flatMap((group) => group.cases).map((c) => [c.id, c.status]));
        const failures = process.env.EXPECTED_CHECKS.split(" ")
            .filter((id) => statuses.get(id) !== "passed")
            .map((id) => `${id}: ${statuses.get(id) ?? "missing"}`);
        if (failures.length > 0) {
            console.error(`Checks not passed:\n  ${failures.join("\n  ")}`);
            process.exit(1);
        }
    ' "$1"
}

# The report goes to stdout and is gated by check_report. The human-readable summary goes to stderr.
run_apps_conformance() {
    local label="$1"
    shift
    local report="$REPORT_DIR/$label.json"

    echo "=== MCP Apps conformance: $label ==="
    pnpm dlx "$MCPJAM_CLI" --no-telemetry apps conformance --reporter json-summary "$@" \
        2> >(redact_tokens >&2) >"$report"
    local cli_status=$?
    if [[ "$cli_status" -ne 0 ]]; then
        echo "mcpjam exited with $cli_status." >&2
        return "$cli_status"
    fi
    check_report "$report"
}

wait_for_server() {
    for _ in $(seq 1 30); do
        curl -s -o /dev/null "http://127.0.0.1:$PORT/" && return 0
        sleep 1
    done
    echo "Dev server did not start on port $PORT." >&2
    return 1
}

pnpm run build || exit $?

status=0

# The stdio child inherits APIFY_TOKEN from this environment, so the token is not in argv.
run_apps_conformance stdio \
    --transport stdio --command node --args dist/stdio.js --args --ui=apps --args "--tools=$WIDGET_TOOLS" \
    || status=1

PORT="$PORT" node dist/dev_server.js > >(redact_tokens) 2>&1 &
SERVER_PID=$!
wait_for_server || exit 1

HTTP_URL="http://127.0.0.1:$PORT/?ui=apps&tools=$WIDGET_TOOLS"

# A credentials file keeps the token out of argv (--header would expose it in ps). The CLI uses
# the file only when its serverUrl equals --url exactly, query string included.
CREDENTIALS_FILE="$REPORT_DIR/credentials.json"
(
    umask 077
    HTTP_URL="$HTTP_URL" node -e '
        process.stdout.write(JSON.stringify({
            version: 1,
            serverUrl: process.env.HTTP_URL,
            accessToken: process.env.APIFY_TOKEN,
        }));
    ' >"$CREDENTIALS_FILE"
) || exit 1

for spec_version in 2025-11-25 2026-07-28; do
    run_apps_conformance "http-$spec_version" \
        --url "$HTTP_URL" \
        --credentials-file "$CREDENTIALS_FILE" \
        --protocol-version "$spec_version" \
        || status=1
done

exit "$status"
