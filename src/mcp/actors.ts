
import { ActorDefinition } from "apify-client";
import { ApifyClient } from "../apify-client.js";


export async function isActorMCPServer(actorID: string, apifyToken: string): Promise<boolean> {
    const mcpPath = await getActorsMCPServerPath(actorID, apifyToken);
    return (mcpPath?.length || 0) > 0;
}

export async function getActorsMCPServerPath(actorID: string, apifyToken: string): Promise<string | undefined> {
    const actorDefinition = await getActorDefinition(actorID, apifyToken);
    return (actorDefinition as any).webServerMcpPath;
}

export async function getActorsMCPServerURL(actorID: string, apifyToken: string): Promise<string> {
    // TODO: get from API instead
    const standbyBaseUrl = process.env.HOSTNAME === 'mcp-securitybyobscurity.apify.com' ?
        'securitybyobscurity.apify.actor' : 'apify.actor';
    const standbyUrl = await getActorStandbyURL(actorID, apifyToken, standbyBaseUrl);
    const mcpPath = await getActorsMCPServerPath(actorID, apifyToken);
    return `${standbyUrl}${mcpPath}`;
}

/**
* Gets Actor ID from the Actor object.
*
* @param actorID
*/
export async function getRealActorID(actorID: string, apifyToken: string): Promise<string> {
    const apifyClient = new ApifyClient({ token: apifyToken });

    const actor = apifyClient.actor(actorID);
    const info = await actor.get();
    if (!info) {
        throw new Error(`Actor ${actorID} not found`);
    }
    return info.id;
}

/**
* Returns standby URL for given Actor ID.
*
* @param actorID
* @param standbyBaseUrl
* @returns
*/
export async function getActorStandbyURL(actorID: string, apifyToken: string, standbyBaseUrl = 'apify.actor'): Promise<string> {
    const actorRealID = await getRealActorID(actorID, apifyToken);
    return `https://${actorRealID}.${standbyBaseUrl}`;
}

export async function getActorDefinition(actorID: string, apifyToken: string): Promise<ActorDefinition> {
    const apifyClient = new ApifyClient({ token: apifyToken
     })
    const actor = apifyClient.actor(actorID);
    const info = await actor.get();
    if (!info) {
        throw new Error(`Actor ${actorID} not found`);
    }
    const latestBuildID = info.taggedBuilds?.['latest']?.buildId;
    if (!latestBuildID) {
        throw new Error(`Actor ${actorID} does not have a latest build`);
    }
    const build = apifyClient.build(latestBuildID);
    const buildInfo = await build.get();
    if (!buildInfo) {
        throw new Error(`Build ${latestBuildID} not found`);
    }
    const actorDefinition = buildInfo.actorDefinition;
    if (!actorDefinition) {
        throw new Error(`Build ${latestBuildID} does not have an actor definition`);
    }

    return actorDefinition;
}
