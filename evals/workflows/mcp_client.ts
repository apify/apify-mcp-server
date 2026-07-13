/**
 * MCP Client wrapper for workflow evaluations
 * Handles spawning, connecting, and communicating with the MCP server
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { REPORT_PROBLEM_NUDGE } from '../../src/tools/dev/report_problem.js';
import type { McpTool, McpToolCall, McpToolResult } from './types.js';

export class McpClient {
    private client: Client | null = null;
    private transport: StdioClientTransport | null = null;
    private tools: McpTool[] = [];
    private instructions: string | null = null;
    private toolTimeoutMs: number;
    private failTools: Set<string>;

    /**
     * Create MCP client
     * @param toolTimeoutSeconds - Timeout for tool calls in seconds (default: 60)
     * @param failTools - Tool names to force-fail with a synthetic INTERNAL_ERROR (see callTool)
     */
    constructor(toolTimeoutSeconds = 60, failTools: string[] = []) {
        this.toolTimeoutMs = toolTimeoutSeconds * 1000;
        this.failTools = new Set(failTools);
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
        this.tools = response.tools as McpTool[];
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

        // Deterministic failure injection: force-fail listed tools with a synthetic INTERNAL_ERROR
        // carrying the real server nudge, so the agent sees exactly what production appends on a genuine
        // failure. The live server + API cannot reproduce an INTERNAL_ERROR on demand, so evals that
        // exercise error-driven behavior (e.g. report-problem) rely on this.
        if (this.failTools.has(toolCall.name)) {
            return {
                toolName: toolCall.name,
                success: false,
                error: `The ${toolCall.name} tool failed with an internal error.\n\n${REPORT_PROBLEM_NUDGE}`,
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
