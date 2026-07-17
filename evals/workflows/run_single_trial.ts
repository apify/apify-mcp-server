#!/usr/bin/env node
/* eslint-disable no-console */
/* eslint-disable import/extensions */
/**
 * ts-executor entrypoint. Runs one test case inside the Harbor task container.
 *
 * Invoked by the custom TsExecutorAgent. Reuses the existing conversation executor + MCP client
 * + LLM client unchanged, then writes an ATIF trajectory to the agent log dir so Harbor's native
 * Opik integration captures spans/tokens uniformly with the claude-code harness. The verifier
 * reads the same trajectory.
 *
 * Args: --instruction-b64 <base64>  --model <model>  --agent-log-dir <dir> (default /logs/agent)
 * Env:  APIFY_TOKEN, OPENROUTER_API_KEY, EVAL_TOOL_TIMEOUT_SECONDS
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { conversationToAtif } from './atif.js';
import { DEFAULT_TOOL_TIMEOUT_SECONDS, MODELS, sanitizeEnvValue } from './config.js';
import { executeConversation } from './conversation_executor.js';
import { ENV_TOOL_TIMEOUT_SECONDS } from './harness.js';
import { LlmClient } from './llm_client.js';
import { McpClient } from './mcp_client.js';
import { parseInstruction } from './task_generator.js';
import type { ConversationHistory } from './types.js';

const AGENT_NAME = 'ts-executor';
const AGENT_VERSION = '1.0.0';

/** Read a `--flag value` pair from argv. */
function readArg(name: string): string | undefined {
    const index = process.argv.indexOf(name);
    return index !== -1 ? process.argv[index + 1] : undefined;
}

async function main() {
    const instructionB64 = readArg('--instruction-b64');
    if (!instructionB64) {
        throw new Error('--instruction-b64 is required');
    }
    const model = readArg('--model') || MODELS.agent;
    const agentLogDir = readArg('--agent-log-dir') || '/logs/agent';

    const { query, config } = parseInstruction(Buffer.from(instructionB64, 'base64').toString('utf8'));

    const apifyToken = sanitizeEnvValue(process.env.APIFY_TOKEN);
    if (!apifyToken) {
        throw new Error('APIFY_TOKEN environment variable is required');
    }
    const toolTimeoutSeconds = Number(process.env[ENV_TOOL_TIMEOUT_SECONDS]) || DEFAULT_TOOL_TIMEOUT_SECONDS;

    const mcpClient = new McpClient(toolTimeoutSeconds, config.failTools);
    const llmClient = new LlmClient();

    let conversation: ConversationHistory;
    try {
        await mcpClient.start(apifyToken, config.tools);
        conversation = await executeConversation({
            userPrompt: query,
            mcpClient,
            llmClient,
            maxTurns: config.maxTurns,
            model,
            serverInstructions: mcpClient.getInstructions(),
        });
    } catch (error) {
        // Emit a valid trajectory recording the failure so the judge sees it and the trace
        // still gets spans, instead of leaving no trajectory for the verifier to read.
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Agent execution failed: ${message}`);
        conversation = {
            userPrompt: query,
            turns: [{ turnNumber: 1, toolCalls: [], toolResults: [], finalResponse: `Execution error: ${message}` }],
            completed: false,
            hitMaxTurns: false,
            totalTurns: 1,
        };
    } finally {
        try {
            await mcpClient.cleanup();
        } catch {
            // Ignore cleanup errors.
        }
    }

    const trajectory = conversationToAtif({
        conversation,
        agentName: AGENT_NAME,
        agentVersion: AGENT_VERSION,
        agentModel: model,
    });

    mkdirSync(agentLogDir, { recursive: true });
    const trajectoryPath = path.join(agentLogDir, 'trajectory.json');
    writeFileSync(trajectoryPath, JSON.stringify(trajectory, null, 2));
    console.log(`Wrote ATIF trajectory to ${trajectoryPath} (${trajectory.steps.length} steps)`);
}

main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
});
