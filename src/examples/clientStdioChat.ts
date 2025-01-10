/* eslint-disable no-console */
/**
 * Create a simple chat client that connects to the Model Context Protocol server using the stdio transport.
 * Based on the user input, the client sends a query to the MCP server, retrieves results and processes them.
 *
 * You can expect the following output:
 *
 * MCP Client Started!
 * Type your queries or 'quit|q|exit' to exit.
 * You: Find to articles about AI agent and return URLs
 * [internal] Received response from Claude: [{"type":"text","text":"I'll search for information about AI agents
 *   and provide you with a summary."},{"type":"tool_use","id":"toolu_01He9TkzQfh2979bbeuxWVqM","name":"search",
 *   "input":{"query":"what are AI agents definition capabilities applications","maxResults":2}}]
 * [internal] Calling tool: {"name":"search","arguments":{"query":"what are AI agents definition ...
 * I can help analyze the provided content about AI agents.
 * This appears to be crawled content from AWS and IBM websites explaining what AI agents are.
 * Let me summarize the key points:
 */

import { execSync } from 'child_process';
import * as readline from 'readline';

import { Anthropic } from '@anthropic-ai/sdk';
import type { Message, ToolUseBlock, MessageParam } from '@anthropic-ai/sdk/resources/messages';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import dotenv from 'dotenv';

dotenv.config({ path: '../../.env' });

const REQUEST_TIMEOUT = 120_000; // 2 minutes
const MAX_TOKENS = 2048; // Maximum tokens for Claude response

// const CLAUDE_MODEL = 'claude-3-5-sonnet-20241022'; // the most intelligent model
// const CLAUDE_MODEL = 'claude-3-5-haiku-20241022'; // a fastest model
const CLAUDE_MODEL = 'claude-3-haiku-20240307'; // a fastest and most compact model for near-instant responsiveness
const DEBUG = true;
const DEBUG_SERVER_PATH = '../../dist/index.js';

const NODE_PATH = execSync('which node').toString().trim();

dotenv.config(); // Load environment variables from .env

export type Tool = {
    name: string;
    description: string | undefined;
    input_schema: unknown;
}

class MCPClient {
    private anthropic: Anthropic;
    private client = new Client(
        {
            name: 'example-client',
            version: '0.1.0',
        },
        {
            capabilities: {}, // Optional capabilities
        },
    );

    private tools: Tool[] = [];

    constructor() {
        this.anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    }

    /**
     * Start the server using node and provided server script path.
     * Connect to the server using stdio transport and list available tools.
     */
    async connectToServer(serverArgs: string[]) {
        const transport = new StdioClientTransport({
            command: NODE_PATH,
            args: serverArgs,
            env: { APIFY_API_TOKEN: process.env.APIFY_API_TOKEN || '' },
        });

        await this.client.connect(transport);
        const response = await this.client.listTools();

        this.tools = response.tools.map((x) => ({
            name: x.name,
            description: x.description,
            input_schema: x.inputSchema,
        }));
        console.log('Connected to server with tools:', this.tools.map((x) => x.name));
    }

    /**
     * Process LLM response and check whether it contains any tool calls.
     * If a tool call is found, call the tool and return the response and save the results to messages with type: user.
     * If the tools response is too large, truncate it to the limit.
     */
    async processMsg(response: Message, messages: MessageParam[]): Promise<MessageParam[]> {
        for (const content of response.content) {
            if (content.type === 'text') {
                messages.push({ role: 'assistant', content: content.text });
            } else if (content.type === 'tool_use') {
                await this.handleToolCall(content, messages);
            }
        }
        return messages;
    }

    /**
     * Call the tool and return the response.
     */
    private async handleToolCall(content: ToolUseBlock, messages: MessageParam[], toolCallCount = 0): Promise<MessageParam[]> {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const params = { name: content.name, arguments: content.input as any };
        console.log(`[internal] Calling tool (count: ${toolCallCount}): ${JSON.stringify(params)}`);
        let results;
        try {
            results = await this.client.callTool(params, CallToolResultSchema, { timeout: REQUEST_TIMEOUT });
            if (results.content instanceof Array && results.content.length !== 0) {
                const text = results.content.map((x) => x.text);
                messages.push({ role: 'user', content: text.join('\n\n') });
            } else {
                messages.push({ role: 'user', content: `No results retrieved from ${params.name}` });
            }
        } catch (error) {
            messages.push({ role: 'user', content: `Error calling tool: ${params.name}, error: ${error}` });
        }
        // Get next response from Claude
        const nextResponse: Message = await this.anthropic.messages.create({
            model: CLAUDE_MODEL,
            max_tokens: MAX_TOKENS,
            messages,
            tools: this.tools as any[], // eslint-disable-line @typescript-eslint/no-explicit-any
        });

        for (const c of nextResponse.content) {
            if (c.type === 'text') {
                messages.push({ role: 'assistant', content: c.text });
            } else if (c.type === 'tool_use' && toolCallCount < 3) {
                return await this.handleToolCall(c, messages, toolCallCount + 1);
            }
        }

        return messages;

        // const lastContent = nextResponse.content[nextResponse.content.length - 1];
        // if (lastContent.type !== 'tool_use' && toolCallCount < 3) {
        //     return this.handleToolCall(lastContent, messages, toolCallCount + 1);
        // }
        //
        // const lastContent = nextResponse.content[nextResponse.content.length - 1];
        // if (lastContent.type !== 'tool_use' && toolCallCount < 3) {
        //     return this.handleToolCall(lastContent, messages, toolCallCount + 1);
        // }
        //
        // if (nextResponse.content typeof ToolUseBlock) {
        //     if (nextResponse.content.slice(-1).type !== 'tool_use' && toolCallCount < 3) {
        //         return this.handleToolCall(nextResponse.content.slice(-1), messages, toolCallCount + 1);
        //     }
        // }
        //
        // messages.push({ role: nextResponse.role, content: nextResponse.content.map((x: TextBlockParam) => x.text || '').join('\n') });
        //
        // return messages;
    }

    /**
     * Process user query by sending it to the server and returning the response.
     * Also, process any tool calls.
     */
    async processQuery(query: string, messages: MessageParam[]): Promise<MessageParam[]> {
        messages.push({ role: 'user', content: query });
        const response: Message = await this.anthropic.messages.create({
            model: CLAUDE_MODEL,
            max_tokens: MAX_TOKENS,
            messages,
            tools: this.tools as any[], // eslint-disable-line @typescript-eslint/no-explicit-any
        });
        console.log('[internal] Received response from Claude:', JSON.stringify(response.content));
        return await this.processMsg(response, messages);
    }

    /**
     * Create a chat loop that reads user input from the console and sends it to the server for processing.
     */
    async chatLoop() {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            prompt: 'You: ',
        });

        console.log("MCP Client Started!\nType your queries or 'quit|q|exit' to exit.");
        rl.prompt();

        let lastPrintMessage = 0;
        const messages: MessageParam[] = [];
        rl.on('line', async (input) => {
            const v = input.trim().toLowerCase();
            if (v === 'quit' || v === 'q' || v === 'exit') {
                rl.close();
                return;
            }
            try {
                await this.processQuery(input, messages);
                for (let i = lastPrintMessage + 1; i < messages.length; i++) {
                    if (messages[i].role === 'assistant') {
                        console.log('CLAUDE:', messages[i].content);
                    } else if (messages[i].role === 'user') {
                        console.log('USER:', messages[i].content.slice(0, 500), '...');
                    } else {
                        console.log('CLAUDE[thinking]:', messages[i].content);
                    }
                }
                lastPrintMessage += messages.length;
            } catch (error) {
                console.error('Error processing query:', error);
            }
            rl.prompt();
        });
    }
}

async function main() {
    const client = new MCPClient();

    if (process.argv.length < 3) {
        if (DEBUG) {
            process.argv.push(DEBUG_SERVER_PATH);
        } else {
            console.error('Usage: node <path_to_server_script>');
            process.exit(1);
        }
    }

    try {
        await client.connectToServer(process.argv.slice(2));
        await client.chatLoop();
    } catch (error) {
        console.error('Error:', error);
    }
}

main().catch(console.error);
