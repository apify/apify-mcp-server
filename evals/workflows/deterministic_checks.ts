/**
 * Code-based checks for the parts of an evaluation whose answer is knowable without an LLM.
 * Their results sit next to the judge's rubric in JudgeResult (see workflow_judge.ts).
 */

import type { ValidateFunction } from 'ajv';
import Ajv from 'ajv';

import type { ConversationHistory, McpTool } from './types.js';

/**
 * Result of comparing the tools the agent called against the test case's expectedTools.
 */
export type ToolSelectionCheck = {
    /** False when the test case declares no expectedTools, so nothing was checked */
    checked: boolean;
    /** Null when checked is false */
    verdict: 'PASS' | 'FAIL' | null;
    /** Expected tool names, deduped and sorted (empty when checked is false) */
    expected: string[];
    /** Tool names the agent actually called, deduped and sorted */
    actual: string[];
};

/**
 * Result of validating every tool call's arguments against that tool's declared inputSchema.
 */
export type SchemaValidityCheck = {
    verdict: 'PASS' | 'FAIL';
    /** Empty array when verdict is PASS */
    invalidCalls: { toolName: string; errors: string[] }[];
};

/**
 * Dedupe and sort so the comparison is order-independent and repeated calls to the same tool
 * count once. Same semantics as the toolsExactMatch evaluator in evals/run_evaluation.ts.
 */
function normalizeToolNames(names: string[]): string[] {
    return Array.from(new Set(names)).sort();
}

function collectCalledToolNames(conversation: ConversationHistory): string[] {
    return normalizeToolNames(conversation.turns.flatMap((turn) => turn.toolCalls.map((call) => call.name)));
}

/**
 * Exact-match the set of tools the agent called against the test case's expectedTools.
 * Returns `checked: false` when the test case declares none, leaving the dimension to the judge.
 */
export function checkToolSelection(
    expectedTools: string[] | undefined,
    conversation: ConversationHistory,
): ToolSelectionCheck {
    const actual = collectCalledToolNames(conversation);

    if (!expectedTools || expectedTools.length === 0) {
        return { checked: false, verdict: null, expected: [], actual };
    }

    const expected = normalizeToolNames(expectedTools);
    return {
        checked: true,
        verdict: JSON.stringify(expected) === JSON.stringify(actual) ? 'PASS' : 'FAIL',
        expected,
        actual,
    };
}

/**
 * Format one AJV error as a single readable line, e.g. `/limit must be integer`.
 */
function formatAjvError(error: { instancePath?: string; message?: string }): string {
    return `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`.trim();
}

/**
 * Validate each tool call's arguments against the declared inputSchema of the tool it named.
 *
 * Known limitation: validation uses the latest snapshot of each tool's schema, not the schema as
 * it was at the moment of that specific call. Dynamic tool schemas do not change mid-run in
 * practice; revisit only if this ever produces a false positive.
 *
 * @param conversation - Conversation whose tool calls are validated
 * @param tools - Tool list snapshot taken after the conversation finished (mcpClient.getTools())
 */
export function checkSchemaValidity(conversation: ConversationHistory, tools: McpTool[]): SchemaValidityCheck {
    // strict: false tolerates the loose schema shapes MCP tools declare (unknown keywords, etc.).
    const ajv = new Ajv({ strict: false });
    const schemaByName = new Map(tools.map((tool) => [tool.name, tool.inputSchema]));
    // Compile once per tool; tool schemas carry a $id, which AJV rejects on a second compile.
    const validators = new Map<string, ValidateFunction | null>();

    function getValidator(toolName: string): ValidateFunction | null {
        if (validators.has(toolName)) return validators.get(toolName) ?? null;

        const schema = schemaByName.get(toolName);
        let validate: ValidateFunction | null = null;
        if (schema) {
            try {
                validate = ajv.compile(schema);
            } catch {
                // An uncompilable schema is a server-side problem, not an agent mistake — skip it.
                validate = null;
            }
        }
        validators.set(toolName, validate);
        return validate;
    }

    const invalidCalls: SchemaValidityCheck['invalidCalls'] = [];

    for (const turn of conversation.turns) {
        for (const call of turn.toolCalls) {
            // A tool absent from the final list (e.g. a since-deregistered dynamic tool) is not a
            // schema question — skip rather than flag it.
            const validate = getValidator(call.name);
            if (!validate || validate(call.arguments)) continue;

            invalidCalls.push({
                toolName: call.name,
                errors: (validate.errors ?? []).map(formatAjvError),
            });
        }
    }

    return {
        verdict: invalidCalls.length === 0 ? 'PASS' : 'FAIL',
        invalidCalls,
    };
}
