# TEMPORARY — delete with the rest of tests/e2e/ when the stateless migration (#1128) closes.
# See tests/e2e/README.md.
#
# Normalizes values that legitimately differ between two runs of the same probe, so that diffing
# two capture directories shows behavioral drift only.
#
# Applied only to cases marked `"redact": true` — live Actor calls and storage reads. Static-surface
# captures (tools-list, tools-get, resources) are already deterministic and must stay untouched:
# key-based nulling would otherwise hit input-schema *property names* such as `computeUnits`.
#
# Two mechanisms:
#   scrub  — rewrites volatile patterns inside strings. Preferred, because it keeps the surrounding
#            sentence intact, so `summary` and `nextStep` still assert their deterministic parts
#            (statuses, item counts, field lists).
#   NULLED — replaces values scrub cannot reach because they are bare numbers.
#
# Both patterns are deliberately narrow, verified against real values and near-misses:
#   - IDs require a digit, so `maxTotalChargeUsd` (17 chars, no digit) survives.
#   - Durations require a decimal point, so `waitSecs (default 30s)` in a description survives.
#
# `content[].text` is handled too: when the text parses as JSON (content[0] mirrors
# structuredContent) it is parsed, redacted and re-serialized so nested numbers are reached.

def NULLED:
    [
        "runTimeSecs",
        "computeUnits",
        "memMaxBytes",
        "durationMillis",
        "durationMs",
        "usageTotalUsd",
        "usageUsd",
        "cpuAvgUsage",
        "cpuMaxUsage",
        "netRxBytes",
        "netTxBytes",
        # Per-store signing secret. A credential — must never reach a snapshot.
        "urlSigningSecretKey",
        # Storage access counters and account-wide totals: they move on every read.
        "readCount",
        "writeCount",
        "listCount",
        "deleteCount",
        "inflatedBytes",
        "storageBytes",
        "total",
        # Task progress text reflects the Actor's state at poll time, so it moves with timing.
        # `status` is deliberately kept: it is the signal these probes exist for.
        "statusMessage",
        "lastUpdatedAt"
    ];

def scrub:
    gsub("\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z"; "<ts>")
    | gsub("\\b(?=[A-Za-z0-9]{17}\\b)(?=[A-Za-z0-9]*[0-9])[A-Za-z0-9]{17}\\b"; "<id>")
    # MCP task IDs are 32 lowercase hex characters, so they miss the Apify-ID pattern above.
    | gsub("\\b[0-9a-f]{32}\\b"; "<taskid>")
    | gsub("\\b\\d+\\.\\d+s\\b"; "<dur>");

def prune:
    walk(
        if type == "object" then
            with_entries(if (.key | IN(NULLED[])) then .value = "<redacted>" else . end)
        elif type == "string" then
            scrub
        else
            .
        end
    );

def redact_embedded_json:
    if (type == "object") and (has("content")) then
        .content |= map(
            if (type == "object") and ((.text? // null) | type == "string") then
                .text |= (. as $raw | try (fromjson | prune | tojson) catch $raw)
            else
                .
            end
        )
    else
        .
    end;

redact_embedded_json | prune
