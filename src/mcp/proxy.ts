import Ajv from "ajv";
import { ActorMCPTool, ToolWrap } from "../types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getMCPServerID, getProxyMCPServerToolName } from "./utils.js";

export async function getMCPServerTools(
    actorID: string,
    client: Client,
    // Name of the MCP server
    serverUrl: string
): Promise<ToolWrap[]> {
    const res = await client.listTools();
    const tools = res.tools;


    const ajv = new Ajv({ coerceTypes: 'array', strict: false });

    const compiledTools: ToolWrap[] = [];
    for (const tool of tools) {
        const mcpTool: ActorMCPTool = {
            actorID,
            serverId: getMCPServerID(serverUrl),
            serverUrl,
            originToolName: tool.name,

            name: getProxyMCPServerToolName(serverUrl, tool.name),
            description: tool.description || "",
            inputSchema: tool.inputSchema,
            ajvValidate: ajv.compile(tool.inputSchema)
        }

        const wrap: ToolWrap = {
            type: 'actor-mcp',
            tool: mcpTool,
        }

        compiledTools.push(wrap);
    }

    return compiledTools;
}
