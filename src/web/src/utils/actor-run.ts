import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * Strip noise that is meant for the model, not the end-user:
 *  - trailing JSON blobs like `{"statusCode":404}`
 *  - "Please verify …" / "You can search …" follow-up lines
 */
function cleanErrorText(raw: string): string {
    // Take only the first meaningful line (the rest is model guidance)
    const firstLine = raw.split("\n")[0].trim();
    // Strip trailing JSON blob (e.g. `{"statusCode":404}`)
    return firstLine.replace(/\s*\{[^}]*}\s*\.?$/, "").trim();
}

export function extractActorRunErrorMessage(toolResult: CallToolResult | null | undefined): string | null {
    if (!toolResult?.isError) {
        return null;
    }

    for (const item of toolResult.content) {
        if (typeof item !== "object" || item === null || !("text" in item)) {
            continue;
        }

        const text = item.text;
        if (typeof text === "string" && text.trim()) {
            const cleaned = cleanErrorText(text);
            return cleaned || text.trim();
        }
    }

    return "Actor run failed before it could start.";
}
