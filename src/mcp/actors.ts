
export async function isActorMCPServer(actorID: string): Promise<boolean> {
    // TODO: implement the logic
    return actorID === 'apify/actors-mcp-server';
}

export async function getActorsMCPServerURL(actorID: string): Promise<string> {
    // TODO: implement the logic
    if (actorID === 'apify/actors-mcp-server') {
        return 'https://actors-mcp-server.apify.actor/sse';
    }
    throw new Error(`Actor ${actorID} is not an MCP server`);
}
