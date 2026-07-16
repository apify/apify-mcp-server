/**
 * MCP Client wrapper for workflow evaluations
 * Handles spawning, connecting, and communicating with the MCP server
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { HELPER_TOOLS } from '../../src/const.js';
import type { McpTool, McpToolCall, McpToolResult } from './types.js';

export type McpToolPolicy = {
    disallowedTools?: string[];
    allowedCallActorTargets?: string[];
    disallowedCallActorTargets?: string[];
};

export class McpClient {
    private client: Client | null = null;
    private transport: StdioClientTransport | null = null;
    private tools: McpTool[] = [];
    private instructions: string | null = null;
    private toolTimeoutMs: number;
    private toolPolicy: McpToolPolicy;

    constructor(toolTimeoutSeconds = 60, toolPolicy: McpToolPolicy = {}) {
        this.toolTimeoutMs = toolTimeoutSeconds * 1000;
        this.toolPolicy = toolPolicy;
    }

    /**
     * Start the MCP server and connect the client
     * @param apifyToken - Apify API token
     * @param tools - Optional list of tools to enable (e.g., ["actors", "docs", "apify/rag-web-browser"])
     */
    async start(apifyToken: string, tools?: string[]): Promise<void> {
        if (this.client) {
            throw new Error('MCP client is already started');
        }

        // Check that dist/stdio.js exists
        const fs = await import('node:fs');
        const path = await import('node:path');
        const stdioBinPath = path.resolve(process.cwd(), 'dist/stdio.js');

        if (!fs.existsSync(stdioBinPath)) {
            throw new Error('MCP server binary not found at dist/stdio.js. ' + 'Please run "pnpm run build" first.');
        }

        // Build args for MCP server
        const args = [stdioBinPath];

        // Add --tools argument if provided
        if (tools && tools.length > 0) {
            args.push(`--tools=${tools.join(',')}`);
        }

        // Create transport with stdio
        this.transport = new StdioClientTransport({
            command: 'node',
            args,
            env: {
                ...process.env,
                APIFY_TOKEN: apifyToken,
            },
        });

        // Create and connect client
        this.client = new Client(
            {
                name: 'workflow-eval-client',
                version: '1.0.0',
            },
            {
                capabilities: {},
            },
        );

        await this.client.connect(this.transport);

        // Load available tools and instructions
        await this.loadTools();
        this.instructions = this.client.getInstructions() || null;
    }

    /**
     * Load and cache available tools from the server
     */
    private async loadTools(): Promise<void> {
        if (!this.client) {
            throw new Error('MCP client is not started');
        }

        const response = await this.client.listTools();
        const disallowedTools = new Set(this.toolPolicy.disallowedTools);
        this.tools = (response.tools as McpTool[]).filter((tool) => !disallowedTools.has(tool.name));
    }

    /**
     * Get list of available tools
     */
    getTools(): McpTool[] {
        return this.tools;
    }

    /**
     * Get server instructions (if provided by the server)
     */
    getInstructions(): string | null {
        return this.instructions;
    }

    /**
     * Call a tool on the MCP server
     */
    async callTool(toolCall: McpToolCall): Promise<McpToolResult> {
        if (!this.client) {
            throw new Error('MCP client is not started');
        }

        const policyViolation = this.getPolicyViolation(toolCall);
        if (policyViolation) {
            return {
                toolName: toolCall.name,
                success: false,
                error: policyViolation,
                policyViolation,
            };
        }

        try {
            const response = await this.client.callTool(
                {
                    name: toolCall.name,
                    arguments: toolCall.arguments,
                },
                undefined, // resultSchema
                {
                    timeout: this.toolTimeoutMs,
                    resetTimeoutOnProgress: true, // Reset timeout on progress notifications
                },
            );

            // Populate error field when isError is true so LLM receives the error message
            return {
                toolName: toolCall.name,
                success: !response.isError,
                result: response.isError ? undefined : response.content,
                error: response.isError ? JSON.stringify(response.content) : undefined,
            };
        } catch (error) {
            // Return raw error message from SDK without modification
            return {
                toolName: toolCall.name,
                success: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }

    private getPolicyViolation(toolCall: McpToolCall): string | undefined {
        if (this.toolPolicy.disallowedTools?.includes(toolCall.name)) {
            return `Evaluation policy forbids tool "${toolCall.name}".`;
        }
        if (toolCall.name !== HELPER_TOOLS.ACTOR_CALL) return undefined;

        const hasTargetPolicy =
            this.toolPolicy.allowedCallActorTargets !== undefined ||
            this.toolPolicy.disallowedCallActorTargets !== undefined;
        if (!hasTargetPolicy) return undefined;

        const { actor } = toolCall.arguments;
        if (typeof actor !== 'string') return 'Evaluation policy requires call-actor to have an Actor target.';

        const actorTarget = actor.split(':', 1)[0];
        if (this.toolPolicy.allowedCallActorTargets && !this.toolPolicy.allowedCallActorTargets.includes(actorTarget)) {
            return `Evaluation policy does not allow call-actor target "${actorTarget}".`;
        }
        if (this.toolPolicy.disallowedCallActorTargets?.includes(actorTarget)) {
            return `Evaluation policy forbids call-actor target "${actorTarget}".`;
        }
        return undefined;
    }

    /**
     * Cleanup and shutdown the MCP client
     * Uses a timeout to prevent indefinite waiting during cleanup
     */
    async cleanup(cleanupTimeoutMs = 2000): Promise<void> {
        // Create timeout promise
        const timeoutPromise = new Promise<void>((resolve) => {
            setTimeout(() => resolve(), cleanupTimeoutMs);
        });

        // Attempt graceful cleanup with timeout
        const cleanupPromise = (async () => {
            if (this.client) {
                await this.client.close();
            }

            if (this.transport) {
                await this.transport.close();
            }
        })();

        // Race between cleanup and timeout
        await Promise.race([cleanupPromise, timeoutPromise]);

        // Force kill transport process if it's still running
        if (this.transport) {
            try {
                // Access the underlying child process and force kill it
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const transportAny = this.transport as any;
                // eslint-disable-next-line no-underscore-dangle
                if (transportAny._process && transportAny._process.kill) {
                    // eslint-disable-next-line no-underscore-dangle
                    transportAny._process.kill('SIGKILL');
                }
            } catch {
                // Ignore errors during force kill
            }
        }

        // Always reset state regardless of cleanup success
        this.client = null;
        this.transport = null;
        this.tools = [];
        this.instructions = null;
    }

    /**
     * Check if client is connected
     */
    isConnected(): boolean {
        return this.client !== null;
    }
}
