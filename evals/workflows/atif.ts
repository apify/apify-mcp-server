/**
 * ATIF (Agent Trajectory Interchange Format) mapping.
 *
 * The ts-executor entrypoint writes an ATIF trajectory to /logs/agent/trajectory.json;
 * Harbor's native Opik integration turns each ATIF step into a nested span. The verifier
 * reads the same file (harness-agnostic) and reconstructs the minimal conversation the
 * judge needs. Both directions live here so the shape stays in one place.
 *
 * Schema mirrors ATIF-v1.7 (harbor.models.trajectories). Only the fields we emit are
 * modeled; Harbor validates the file with `extra: forbid`, so no unknown keys are added.
 */

import type { ConversationHistory, ConversationTurn } from './types.js';

/** A tool call inside an agent step. */
export type AtifToolCall = {
    tool_call_id: string;
    function_name: string;
    arguments: Record<string, unknown>;
};

/** A single result inside an observation, paired to its tool call by id. */
export type AtifObservationResult = {
    source_call_id: string | null;
    content: string;
};

/** One step of the trajectory (a turn). */
export type AtifStep = {
    step_id: number;
    source: 'system' | 'user' | 'agent';
    message: string;
    timestamp?: string;
    model_name?: string;
    tool_calls?: AtifToolCall[];
    observation?: { results: AtifObservationResult[] };
};

/** Aggregate metrics for the whole trajectory. */
export type AtifFinalMetrics = {
    total_prompt_tokens?: number;
    total_completion_tokens?: number;
    total_steps?: number;
};

/** A complete ATIF trajectory document. */
export type AtifTrajectory = {
    schema_version: 'ATIF-v1.7';
    session_id?: string;
    agent: {
        name: string;
        version: string;
        model_name?: string;
    };
    steps: AtifStep[];
    final_metrics?: AtifFinalMetrics;
    // Root-level custom metadata (ATIF `extra`). We carry the conversation completion flags here
    // so the verifier can read them back instead of guessing.
    extra?: { completed?: boolean; hitMaxTurns?: boolean };
};

export type ConversationToAtifOptions = {
    conversation: ConversationHistory;
    agentName: string;
    agentVersion: string;
    agentModel: string;
    sessionId?: string;
};

/** Serialize a tool result the way the agent received it (matches conversation_executor). */
function serializeToolResult(result: { success: boolean; result?: unknown; error?: string }): string {
    return result.success ? JSON.stringify(result.result) : JSON.stringify({ error: result.error });
}

/** Build the agent step for a single conversation turn. */
function turnToStep(turn: ConversationTurn, stepId: number, agentModel: string): AtifStep {
    const step: AtifStep = {
        step_id: stepId,
        source: 'agent',
        message: turn.finalResponse ?? '',
        model_name: agentModel,
    };

    if (turn.toolCalls.length === 0) {
        return step;
    }

    // Pair each tool call with its result by index so the observation's source_call_id
    // references a tool_call_id in the same step (ATIF requires this).
    const toolCalls: AtifToolCall[] = turn.toolCalls.map((toolCall, index) => ({
        tool_call_id: `${stepId}-${index}`,
        function_name: toolCall.name,
        arguments: toolCall.arguments,
    }));

    const results: AtifObservationResult[] = turn.toolResults.map((result, index) => ({
        source_call_id: toolCalls[index]?.tool_call_id ?? null,
        content: serializeToolResult(result),
    }));

    step.tool_calls = toolCalls;
    if (results.length > 0) {
        step.observation = { results };
    }
    return step;
}

/**
 * Convert an executed conversation into an ATIF trajectory. Step 1 is the user prompt;
 * each conversation turn becomes one agent step (tool calls + their results, then the
 * final text response on the closing turn).
 */
export function conversationToAtif(options: ConversationToAtifOptions): AtifTrajectory {
    const { conversation, agentName, agentVersion, agentModel, sessionId } = options;

    const steps: AtifStep[] = [{ step_id: 1, source: 'user', message: conversation.userPrompt }];
    for (const turn of conversation.turns) {
        steps.push(turnToStep(turn, steps.length + 1, agentModel));
    }

    // Synthetic increasing timestamps: the executor does not record per-step times, but the Opik
    // integration uses step.timestamp as the span start time, so ordered stamps keep spans in order.
    const baseTime = Date.now();
    for (const step of steps) {
        step.timestamp = new Date(baseTime + (step.step_id - 1) * 1000).toISOString();
    }

    const trajectory: AtifTrajectory = {
        schema_version: 'ATIF-v1.7',
        agent: { name: agentName, version: agentVersion, model_name: agentModel },
        steps,
        final_metrics: {
            ...(conversation.promptTokens !== undefined ? { total_prompt_tokens: conversation.promptTokens } : {}),
            ...(conversation.completionTokens !== undefined
                ? { total_completion_tokens: conversation.completionTokens }
                : {}),
            total_steps: steps.length,
        },
        extra: { completed: conversation.completed, hitMaxTurns: conversation.hitMaxTurns },
    };
    if (sessionId) {
        trajectory.session_id = sessionId;
    }
    return trajectory;
}

/** The minimal conversation shape the judge needs (userPrompt + turns). */
export type JudgeConversation = Pick<
    ConversationHistory,
    'userPrompt' | 'turns' | 'completed' | 'hitMaxTurns' | 'totalTurns'
>;

/** Flatten a possibly-multimodal ATIF message to plain text. */
function messageText(message: AtifStep['message']): string {
    return typeof message === 'string' ? message : '';
}

/**
 * Reconstruct the conversation the judge scores from an ATIF trajectory. Works for any
 * ATIF producer (the ts-executor entrypoint or Harbor's built-in claude-code agent): the
 * first user step is the prompt, and every agent step becomes a turn carrying its tool
 * calls and final text. Tool results are dropped; the judge never sees raw results.
 */
export function atifToConversation(trajectory: AtifTrajectory): JudgeConversation {
    const userStep = trajectory.steps.find((step) => step.source === 'user');
    const userPrompt = userStep ? messageText(userStep.message) : '';

    const turns: ConversationTurn[] = [];
    for (const step of trajectory.steps) {
        if (step.source !== 'agent') continue;
        const text = messageText(step.message);
        turns.push({
            turnNumber: turns.length + 1,
            toolCalls: (step.tool_calls ?? []).map((toolCall) => ({
                name: toolCall.function_name,
                arguments: toolCall.arguments,
            })),
            toolResults: [],
            ...(text ? { finalResponse: text } : {}),
        });
    }

    // Producers we control (ts-executor) carry these in `extra`; claude-code trajectories omit
    // them, so default there. The judge does not consume these fields (formatConversationForJudge
    // reads only userPrompt + turns), but keeping them honest avoids a misleading reconstruction.
    return {
        userPrompt,
        turns,
        completed: trajectory.extra?.completed ?? true,
        hitMaxTurns: trajectory.extra?.hitMaxTurns ?? false,
        totalTurns: turns.length,
    };
}
