import type { ActorDefinition } from 'apify-client';

import { ApifyClient, getApifyAPIBaseUrl } from '../apify-client.js';

export async function isActorMCPServer(actorID: string, apifyToken: string): Promise<boolean> {
    const mcpPath = await getActorsMCPServerPath(actorID, apifyToken);
    return (mcpPath?.length || 0) > 0;
}

export async function getActorsMCPServerPath(actorID: string, apifyToken: string): Promise<string | undefined> {
    const actorDefinition = await getActorDefinition(actorID, apifyToken);

    if ('webServerMcpPath' in actorDefinition && typeof actorDefinition.webServerMcpPath === 'string') {
        return actorDefinition.webServerMcpPath;
    }

    return undefined;
}

export async function getActorsMCPServerURL(actorID: string, apifyToken: string): Promise<string> {
    // TODO: get from API instead
    const standbyBaseUrl = process.env.HOSTNAME === 'mcp-securitybyobscurity.apify.com'
        ? 'securitybyobscurity.apify.actor' : 'apify.actor';
    const standbyUrl = await getActorStandbyURL(actorID, apifyToken, standbyBaseUrl);
    const mcpPath = await getActorsMCPServerPath(actorID, apifyToken);
    return `${standbyUrl}${mcpPath}`;
}

/**
* Gets Actor ID from the Actor object.
*
* @param actorID
* @param apifyToken
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
* @param apifyToken
* @returns
*/
export async function getActorStandbyURL(actorID: string, apifyToken: string, standbyBaseUrl = 'apify.actor'): Promise<string> {
    const actorRealID = await getRealActorID(actorID, apifyToken);
    return `https://${actorRealID}.${standbyBaseUrl}`;
}

export async function getActorDefinition(actorID: string, apifyToken: string): Promise<ActorDefinition> {
    const apifyClient = new ApifyClient({ token: apifyToken });
    const actor = apifyClient.actor(actorID);
    const info = await actor.get();
    if (!info) {
        throw new Error(`Actor ${actorID} not found`);
    }

    const actorObjID = info.id;
    const res = await fetch(`${getApifyAPIBaseUrl()}/v2/acts/${actorObjID}/builds/default`, {
        headers: {
            // This is done so tests can pass with public Actors without token
            ...(apifyToken ? { Authorization: `Bearer ${apifyToken}` } : {}),
        },
    });
    if (!res.ok) {
        throw new Error(`Failed to fetch default build for actor ${actorID}: ${res.statusText}`);
    }
    const json = await res.json() as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const buildInfo = json.data;
    if (!buildInfo) {
        throw new Error(`Default build for Actor ${actorID} not found`);
    }
    const { actorDefinition } = buildInfo;
    if (!actorDefinition) {
        throw new Error(`Actor default build ${actorID} does not have Actor definition`);
    }

    return actorDefinition;
}
