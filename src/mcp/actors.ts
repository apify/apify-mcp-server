
import { getActorStandbyURL } from "./utils.js";

export async function isActorMCPServer(actorID: string, _apifyToken: string): Promise<boolean> {
    // TODO: implement the logic
    return actorID.toLowerCase().includes('mcp-') || actorID.toLowerCase().includes('-mcp');
}

export async function getActorsMCPServerURL(actorID: string, _apifyToken: string): Promise<string> {
    // TODO: get from API instead
    const standbyBaseUrl = process.env.HOSTNAME === 'mcp-securitybyobscurity.apify.com' ?
        '.mcp-securitybyobscurity.apify.actor' : '.apify.actor';
    const standbyUrl = getActorStandbyURL(actorID, standbyBaseUrl);
    return `${standbyUrl}/sse`;
}
