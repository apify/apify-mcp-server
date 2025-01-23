/* eslint-disable no-console */
/**
 * Create an MCP client that connects to the server using SSE transport.
 *
 */

import path from 'path';
import { fileURLToPath } from 'url';

import { Anthropic } from '@anthropic-ai/sdk';
import type { Message, ToolUseBlock, MessageParam } from '@anthropic-ai/sdk/resources/messages';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import dotenv from 'dotenv';
import { EventSource } from 'eventsource';

const filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);

dotenv.config({ path: path.resolve(dirname, '../../.env') });

const REQUEST_TIMEOUT = 120_000; // 2 minutes
const MAX_TOKENS = 2048; // Maximum tokens for Claude response

// const CLAUDE_MODEL = 'claude-3-5-sonnet-20241022'; // the most intelligent model
// const CLAUDE_MODEL = 'claude-3-5-haiku-20241022'; // a fastest model
const CLAUDE_MODEL = 'claude-3-haiku-20240307'; // a fastest and most compact model for near-instant responsiveness

const SERVER_URL = 'http://localhost:3001/sse';

const SYSTEM_PROMPT = 'You are a helpful assistant with to tools called Actors\n' +
    '\n' +
    'Choose the appropriate tool based on the user\'s question. If no tool is needed, reply directly.\n' +
    '\n' +
    'IMPORTANT: When you need to use a tool, explain how the tools was used and with which parameters\n' +
    'IMPORTANT: When a tool was called, the message starts with [internal] and is submitted by user' +
    '\n' +
    'After receiving a tool\'s response:\n' +
    '1. Transform the raw data into a natural, conversational response\n' +
    '2. Keep responses concise but informative\n' +
    '3. Focus on the most relevant information\n' +
    '4. Use appropriate context from the user\'s question\n' +
    '5. Avoid simply repeating the raw data\n' +
    '\n' +
    'Always use Actor not actor' +
    'Always replace underscore in Actor name by forward slash, i.e. apify/rag-web-browser not apify_rag-web-browser' +
    'Provide an URL to Actor whenever possible such as [apify/rag-web-browser](https://apify.com/apify/rag-web-browser)' +
    '\n' +
    'REMEMBER Always limit number of results returned from Actors/tools. ' +
    'There is always parameter such as maxResults=1, maxPage=1, maxCrawledPlacesPerSearch=1, keep it to minimal value.' +
    'Otherwise tool execution takes long and result is huge!'

if (typeof globalThis.EventSource === 'undefined') {
    globalThis.EventSource = EventSource as unknown as typeof globalThis.EventSource;
}

export type Tool = {
    name: string;
    description: string | undefined;
    input_schema: unknown;
}

export class MCPClient {
    private anthropic: Anthropic;
    private client = new Client(
        { name: 'example-client', version: '0.1.0' },
        { capabilities: {} },
    );

    private tools: Tool[] = [];

    constructor() {
        this.anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    }

    /**
     * Start the server using node and provided server script path.
     * Connect to the server using stdio transport and list available tools.
     */
    async connectToServer() {
        const transport = new SSEClientTransport(
            new URL(SERVER_URL),
            {
                requestInit: {
                    headers: {
                        authorization: `Bearer ${process.env.APIFY_TOKEN}`,
                    },
                },
                eventSourceInit: {
                    // The EventSource package augments EventSourceInit with a "fetch" parameter.
                    // You can use this to set additional headers on the outgoing request.
                    // Based on this example: https://github.com/modelcontextprotocol/typescript-sdk/issues/118
                    async fetch(input: Request | URL | string, init?: RequestInit) {
                        const headers = new Headers(init?.headers || {});
                        headers.set('authorization', `Bearer ${process.env.APIFY_TOKEN}`);
                        return fetch(input, { ...init, headers });
                    },
                    // We have to cast to "any" to use it, since it's non-standard
                } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
            },
        );
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
                messages.push({ role: 'user', content: `[internal] Calling tool ${JSON.stringify(params)}`});
                messages.push({ role: 'user', content: `[internal] Tool result: ${text.join('\n\n')}` });
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
            system: SYSTEM_PROMPT,
            tools: this.tools as any[], // eslint-disable-line @typescript-eslint/no-explicit-any
        });
        console.log('[internal] Received response from Claude:', JSON.stringify(response.content));
        return await this.processMsg(response, messages);
    }
}
