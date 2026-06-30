import { HELPER_TOOLS, type HelperToolName } from '../const.js';

export const PAYMENT_PROTOCOL_HEADER = 'x-apify-payment-protocol';

const SKYFIRE_MIN_CHARGE_USD = 5.0;
const SKYFIRE_SELLER_ID = process.env.SKYFIRE_SELLER_SERVICE_ID;

export const SKYFIRE_TOOL_INSTRUCTIONS = `To run the Actor, you need to provide a Skyfire PAY JWT token in the \`skyfire-pay-id\` input property. You first need to create the Skyfire PAY token by calling the \`create-pay-token\` tool from the Skyfire MCP server and then provide the created JWT token in the \`skyfire-pay-id\` input property when calling Actor tool. IMPORTANT: The value you pass to \`skyfire-pay-id\` must be the JWT token string itself (it starts with "ey"), NOT an ID or UUID. The Skyfire PAY token is used for billing purposes and needs to be charged with at least ${SKYFIRE_MIN_CHARGE_USD} USD.${SKYFIRE_SELLER_ID ? ` The Skyfire seller ID for Apify MCP server is "${SKYFIRE_SELLER_ID}".` : ''} When retrieving Actor output using the \`get-dataset-items\` tool, you also need to provide the same Skyfire PAY JWT token (starting with "ey") in the \`skyfire-pay-id\` input property.`;

export const SKYFIRE_PAY_ID_PROPERTY_DESCRIPTION = `Skyfire PAY JWT token used for billing purposes. This must be the JWT token string returned by the create-pay-token tool (starts with "ey"), NOT a token ID or UUID.`;

export const SKYFIRE_README_CONTENT = `The Apify MCP Server allows clients to interact with Apify Actors, storage, and documentation. Before running any Apify Actor, you need to set up a Skyfire PAY token for billing purposes. To set up the PAY token you need to use the create-pay-token tool from the Skyfire MCP server. The PAY token must be charged with a minimum of ${SKYFIRE_MIN_CHARGE_USD} USD to be valid.${SKYFIRE_SELLER_ID ? ` The Skyfire seller ID for Apify MCP server is "${SKYFIRE_SELLER_ID}".` : ''} When running an Actor using the call-actor tool, you must provide the Skyfire PAY JWT token in the \`skyfire-pay-id\` input property. IMPORTANT: The value for \`skyfire-pay-id\` must be the actual JWT token string (starting with "ey") returned by the create-pay-token tool, NOT a token ID or UUID. Similarly, when retrieving Actor output using the get-dataset-items tool, you must also provide the same Skyfire PAY JWT token (starting with "ey") in the \`skyfire-pay-id\` input property.`;

/**
 * Set of internal tool names that require Skyfire PAY token ID in Skyfire mode.
 * These tools interact with Actor runs, datasets, or key-value stores and need billing support.
 */
export const SKYFIRE_ENABLED_TOOLS = new Set<HelperToolName>([
    HELPER_TOOLS.ACTOR_CALL,
    HELPER_TOOLS.ACTOR_RUNS_GET,
    HELPER_TOOLS.ACTOR_RUNS_LOG,
    HELPER_TOOLS.ACTOR_RUNS_ABORT,
    HELPER_TOOLS.DATASET_GET,
    HELPER_TOOLS.DATASET_GET_ITEMS,
    HELPER_TOOLS.DATASET_SCHEMA_GET,
    HELPER_TOOLS.KEY_VALUE_STORE_GET,
    HELPER_TOOLS.KEY_VALUE_STORE_KEYS_GET,
    HELPER_TOOLS.KEY_VALUE_STORE_RECORD_GET,
]);
