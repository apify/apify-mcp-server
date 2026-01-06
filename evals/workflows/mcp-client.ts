/**
 * MCP Client wrapper for workflow evaluations
 * Handles spawning, connecting, and communicating with the MCP server
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { McpTool, McpToolCall, McpToolResult } from './types.js';

export class McpClient {
    private client: Client | null = null;
    private transport: StdioClientTransport | null = null;
    private tools: McpTool[] = [];
    private toolTimeoutMs: number;

    /**
     * Create MCP client
     * @param toolTimeoutSeconds - Timeout for tool calls in seconds (default: 60)
     */
    constructor(toolTimeoutSeconds: number = 60) {
        this.toolTimeoutMs = toolTimeoutSeconds * 1000;
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
        const fs = await import('fs');
        const path = await import('path');
        const stdioBinPath = path.resolve(process.cwd(), 'dist/stdio.js');
        
        if (!fs.existsSync(stdioBinPath)) {
            throw new Error(
                'MCP server binary not found at dist/stdio.js. ' +
                'Please run "npm run build" first.'
            );
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
            }
        );

        await this.client.connect(this.transport);

        // Load available tools
        await this.loadTools();
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
     * Call a tool on the MCP server
     */
    async callTool(toolCall: McpToolCall): Promise<McpToolResult> {
        if (!this.client) {
            throw new Error('MCP client is not started');
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
                }
            );

            return {
                toolName: toolCall.name,
                success: !response.isError,
                result: response.content,
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
     */
    async cleanup(): Promise<void> {
        if (this.client) {
            await this.client.close();
            this.client = null;
        }
        
        if (this.transport) {
            await this.transport.close();
            this.transport = null;
        }

        this.tools = [];
    }

    /**
     * Check if client is connected
     */
    isConnected(): boolean {
        return this.client !== null;
    }
}
