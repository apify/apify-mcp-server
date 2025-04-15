
import { ActorDefinition } from "apify-client";
import { getActorDefinition, getActorStandbyURL } from "./utils.js";

export async function isActorMCPServer(actorID: string, apifyToken: string): Promise<boolean> {
    const mcpPath = await getActorsMCPServerPath(actorID, apifyToken);
    return (mcpPath?.length || 0) > 0;
}

export async function getActorsMCPServerPath(actorID: string, apifyToken: string): Promise<string | undefined> {
    const actorDefinition = await getActorDefinition(actorID, apifyToken);
    return (actorDefinition as any).webServerMcpPath;
}

export async function getActorsMCPServerURL(actorID: string, _apifyToken: string): Promise<string> {
    // TODO: get from API instead
    const standbyBaseUrl = process.env.HOSTNAME === 'mcp-securitybyobscurity.apify.com' ?
        'securitybyobscurity.apify.actor' : 'apify.actor';
    const standbyUrl = getActorStandbyURL(actorID, standbyBaseUrl);
    const mcpPath = await getActorsMCPServerPath(actorID, _apifyToken);
    return `${standbyUrl}${mcpPath}`;
}
