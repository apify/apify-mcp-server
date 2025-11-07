import { Analytics } from '@segment/analytics-node';

const DEV_WRITE_KEY = '9rPHlMtxX8FJhilGEwkfUoZ0uzWxnzcT';
const PROD_WRITE_KEY = 'cOkp5EIJaN69gYaN8bcp7KtaD0fGABwJ';

const SEGMENT_EVENTS = {
    TOOL_CALL: 'MCP Tool Call',
};

// Map to store singleton Segment Analytics clients per environment
const analyticsClients = new Map<'dev' | 'prod', Analytics>();

/**
 * Gets or initializes a Segment Analytics client for the specified environment.
 * This ensures that only one client is created per environment, even if multiple
 * ActorsMcpServer instances are initialized with telemetry enabled.
 *
 * @param env - 'dev' for development, 'prod' for production
 * @returns Analytics client instance
 */
export function getOrInitAnalyticsClient(env: 'dev' | 'prod'): Analytics {
    if (!analyticsClients.has(env)) {
        const writeKey = env === 'prod' ? PROD_WRITE_KEY : DEV_WRITE_KEY;
        analyticsClients.set(env, new Analytics({ writeKey }));
    }
    return analyticsClients.get(env)!;
}

/**
 * Tracks a tool call event to Segment.
 *
 * @param userId - Apify user ID (TODO: extract from token when auth available)
 * @param env - 'dev' for development, 'prod' for production
 * @param properties - Additional event properties
 */
export function trackToolCall(
    userId: string,
    env: 'dev' | 'prod',
    properties: Record<string, string>,
): void {
    const client = getOrInitAnalyticsClient(env);

    // TODO: Implement anonymousId tracking for device/session identification
    client.track({
        userId: userId || 'anonymous',
        event: SEGMENT_EVENTS.TOOL_CALL,
        properties,
    });
}
