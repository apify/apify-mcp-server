# Sourced by the conformance scripts. Defines `redact_tokens`, a filter that replaces the raw and
# percent-encoded APIFY_TOKEN in its input with ***REDACTED***.

export ENCODED_APIFY_TOKEN
ENCODED_APIFY_TOKEN=$(node -p 'encodeURIComponent(process.env.APIFY_TOKEN)')

# Flushes every line so a long-running suite doesn't look hung. Reads via ENVIRON, not awk's -v --
# -v backslash-escapes its value, so a token with a literal backslash would silently leak
# unredacted; ENVIRON also keeps it out of argv.
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
