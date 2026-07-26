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
    # MCP task IDs are 32 lowercase hex characters.
    | gsub("\\b[0-9a-f]{32}\\b"; "<taskid>")
    | gsub("\\b\\d+\\.\\d+s\\b"; "<dur>")
    # List summaries quote an account-wide total ("Listed 2 of 112 datasets."), which grows as the
    # suite itself creates storages. The page size before it stays visible.
    | gsub("of (?<n>\\d+) (?<k>datasets|key-value stores|runs)"; "of <n> \(.k)");

# Apify IDs are 17 base62 characters. Collect them only where they appear as a *whole* string
# value — there they are unambiguously identifiers — then replace those exact literals everywhere,
# including inside prose ("Run <id> was created") and inside serialized JSON.
#
# The earlier heuristic matched any 17-char run of base62 that contained a digit, to spare
# `maxTotalChargeUsd`. It failed in both directions:
#   - it missed the ~5% of real IDs with no digit at all (`TeImCqaYBKkirMfpw`), which then showed
#     up as permanent false diffs;
#   - it corrupted scientific notation, rewriting `4.5850133895874023E-7` to `4.<id>-7` because the
#     mantissa is 17 base62 characters, which left embedded JSON unparseable.
# Collecting concrete values instead of guessing from shape avoids both.
# Candidates that also occur as an object key are schema property names, not identifiers — that is
# what keeps `maxTotalChargeUsd` (17 chars, appears under `properties`) intact.
def replace_ids:
    ([.. | objects | keys[]] | unique) as $keys
    # Standalone values: `"runId": "abc…"`.
    | ([.. | strings | select(test("^[A-Za-z0-9]{17}$"))]) as $whole
    # URL path segments: `…/key-value-stores/abc…/records/COVER`. Storage reads return IDs only
    # inside `recordPublicUrl`-style links and the resource `uri`, never as a bare value, so
    # without this collector those probes diff on every run.
    | ([.. | strings | [scan("/([A-Za-z0-9]{17})(?=[/?\"]|$)")] | flatten[]]) as $inUrls
    | (($whole + $inUrls | unique) - $keys) as $ids
    | reduce $ids[] as $id (.; walk(if type == "string" then gsub($id; "<id>") else . end));

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

def redact_text_parts:
    map(
        if (type == "object") and ((.text? // null) | type == "string") then
            .text |= (. as $raw | try (fromjson | prune | tojson) catch $raw)
        else
            .
        end
    );

# `tools/call` returns `content`; `resources/read` returns `contents`. Both carry serialized JSON.
def redact_embedded_json:
    if type == "object" then
        (if has("content") then .content |= redact_text_parts else . end)
        | (if has("contents") then .contents |= redact_text_parts else . end)
    else
        .
    end;

redact_embedded_json | prune | replace_ids
