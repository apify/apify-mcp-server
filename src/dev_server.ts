/*
 * Express server implementation used for standby Actor mode.
 *
 * Serves two MCP protocol revisions on one endpoint:
 * - stateful Streamable HTTP with sessions, per the 2025-era spec
 *   (https://modelcontextprotocol.io/specification/2025-11-25), via `@modelcontextprotocol/sdk`
 * - stateless single requests, per the 2026-07-28 revision
 *   (https://modelcontextprotocol.io/specification/2026-07-28), via the v2 SDK
 *   (`@modelcontextprotocol/server` + `@modelcontextprotocol/node`)
 */

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import type { NodeIncomingMessageLike } from '@modelcontextprotocol/node';
import {
    localhostHostValidation,
    localhostOriginValidation,
    toNodeHandler,
    toWebRequest,
} from '@modelcontextprotocol/node';
import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { InitializeRequestParams } from '@modelcontextprotocol/sdk/types.js';
import { InitializeRequestParamsSchema } from '@modelcontextprotocol/sdk/types.js';
import type { AuthInfo } from '@modelcontextprotocol/server';
import { createMcpHandler, isLegacyRequest, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/server';
import type { Request, Response } from 'express';
import express from 'express';

import log from '@apify/log';
import { parseBooleanOrNull } from '@apify/utilities';

import { ApifyClient } from './apify_client.js';
import { MAX_REQUEST_BODY_BYTES } from './const.js';
import { buildMcpClientContext } from './mcp/client_context.js';
import { ActorsMcpServer } from './mcp/server.js';
import { createStatelessServer } from './mcp/stateless_server.js';
import type { PaymentProvider } from './payments/index.js';
import { resolvePaymentProvider } from './payments/index.js';
import { sanitizeMezmoMessage, toPlainError } from './utils/logging.js';
import { injectMcpSessionId } from './utils/mcp.js';
import { getRequestOriginForClient } from './utils/mcp_clients.js';
import { parseServerMode } from './utils/server_mode.js';

// DEV ONLY. This is a local dev/standby-emulation server, not the hosted HTTP server.
// The production Streamable HTTP transport (auth, rate limiting, Redis-backed session
// lifecycle, multi-node) lives in apify-mcp-server-internal. Do not treat this file as
// the source of HTTP-transport semantics or send PRs here to mirror production behavior;
// fix production-facing HTTP behavior in the internal repo.
//
// Default telemetry to the DEV Segment source so local tool calls never land in PROD
// analytics. Still overridable by an explicit TELEMETRY_ENV (e.g. PROD) in the env.
process.env.TELEMETRY_ENV ??= 'DEV';

/**
 * Mirrors `apify-mcp-server-internal`'s `extractApiTokenFromRequest`: the `Authorization: Bearer`
 * header, then the `?token=` query parameter.
 */
function extractApiTokenFromRequest(req: Request): string | undefined {
    const value = req.headers.authorization;
    if (typeof value === 'string') {
        const [schema, token] = value.trim().split(/\s+/);
        if (schema?.toLowerCase() === 'bearer' && token) return token;
    }
    try {
        const tokenFromUrl = new URL(req.url ?? '', `http://${req.headers.host}`).searchParams.get('token');
        return tokenFromUrl || undefined;
    } catch (error) {
        log.softFail('Failed to parse request URL for token extraction', {
            url: req.url,
            errMessage: error instanceof Error ? error.message : String(error),
        });
        return undefined;
    }
}

function buildJsonRpcError(code: number, message: string) {
    return { jsonrpc: '2.0', error: { code, message }, id: null };
}

/** The 401 body both eras send for a missing token, JSON-RPC-shaped like production's. */
const UNAUTHORIZED_RESPONSE_BODY = buildJsonRpcError(
    -32001,
    'Unauthorized: Apify API token is missing. Pass it as `Authorization: Bearer <token>`, or set `?payment=<provider>` to use a third-party payment provider.',
);

/**
 * `WWW-Authenticate` challenge sent with that 401 (RFC 6750 §3). Hand-written because the SDK's
 * `bearerAuthChallengeResponse` answers with an OAuth error body, not the JSON-RPC body production sends.
 */
const UNAUTHORIZED_CHALLENGE =
    'Bearer error="invalid_token", error_description="Apify API token missing. Create one at https://console.apify.com/settings/integrations"';

/**
 * Returns the resolved token for a request, or sends a 401 response.
 * In payment mode, no token is required — returns `{ apifyToken: undefined }`.
 */
function resolveRequestAuth(
    req: Request,
    res: Response,
    paymentProvider: PaymentProvider | undefined,
): { apifyToken: string | undefined } | null {
    if (paymentProvider) return { apifyToken: undefined };

    const apifyToken = extractApiTokenFromRequest(req);
    if (apifyToken) return { apifyToken };

    log.softFail('Apify API token missing on unauthenticated request', { statusCode: 401 });
    res.status(401).set('WWW-Authenticate', UNAUTHORIZED_CHALLENGE).json(UNAUTHORIZED_RESPONSE_BODY);
    return null;
}

/** Server settings both eras read from URL params, falling back to env vars like production does. */
async function parseUrlParams(req: Request) {
    const urlParams = new URL(req.url, `http://${req.headers.host}`).searchParams;
    const uiParam = urlParams.get('ui');
    return {
        telemetryEnabled:
            parseBooleanOrNull(urlParams.get('telemetry-enabled')) ??
            parseBooleanOrNull(process.env.TELEMETRY_ENABLED) ??
            true,
        serverMode: uiParam !== null ? parseServerMode(uiParam) : parseServerMode(process.env.UI_MODE),
        paymentProvider: await resolvePaymentProvider(urlParams.get('payment')),
        // Client attribution tag (e.g. ?client=cursor), for Segment and tool wording.
        clientParam: urlParams.get('client') ?? undefined,
    };
}

/** The request fields era routing reads. Narrow so it can be exercised without an HTTP server. */
type EraRoutableRequest = {
    method?: string;
    url?: string;
    headers: Record<string, string | string[] | undefined>;
    body?: unknown;
};

/**
 * Whether the 2026-07-28 stateless path must answer this request instead of the stateful one.
 * Uses the SDK's own discriminator: `true` covers claim-less traffic (2025-era `initialize` and
 * follow-ups, body-less session GET/DELETE, and unparseable bodies). `false` covers everything the
 * 2026-07-28 entry answers, including its own validation rejections, which must not be re-routed.
 */
export async function isStatelessRequest(req: EraRoutableRequest): Promise<boolean> {
    // `express.json()` already parsed the body, so nothing is read from the stream — which is what
    // lets the narrow shape above stand in for a full `IncomingMessage`.
    return !(await isLegacyRequest(await toWebRequest(req as NodeIncomingMessageLike, req.body)));
}

/**
 * Whether a `GET`/`DELETE` came from a client on a revision that dropped the GET stream and
 * protocol-level sessions, leaving `405` as the only answer. Those methods carry no body for era
 * routing to read, so the version header decides; a request that still names a session keeps its
 * stateful handling. Mirrors `apify-mcp-server-internal`'s `isSessionlessEraRequest`.
 */
function isSessionlessEraRequest(req: Pick<Request, 'headers'>): boolean {
    const version = req.headers['mcp-protocol-version'];
    if (typeof version !== 'string' || SUPPORTED_PROTOCOL_VERSIONS.includes(version)) return false;

    return req.headers['mcp-session-id'] === undefined;
}

/**
 * Serves one 2026-07-28 request: no session id, no handshake, nothing retained afterwards.
 *
 * The missing-token 401 is resolved inside the server factory, not up front: SEP-2243 requires
 * framing rejections (400/-32020) regardless of auth state, and the SDK runs that validation
 * before invoking the factory. A server is built per request, so `?actors=` re-fetches Actor
 * metadata every time.
 */
async function serveStatelessRequest(req: Request, res: Response, taskStore: InMemoryTaskStore): Promise<void> {
    const { telemetryEnabled, serverMode, paymentProvider, clientParam } = await parseUrlParams(req);

    // No token required in payment mode, mirroring `resolveRequestAuth`.
    const apifyToken = paymentProvider ? undefined : extractApiTokenFromRequest(req);
    let unauthorized = false;

    const handler = createMcpHandler(
        async ({ requestInfo }) => {
            // `server/discover` needs no token and no tools: it reports only capabilities and
            // instructions. The SDK has already checked the `mcp-method` header against the body.
            const isDiscoverProbe = requestInfo?.headers.get('mcp-method') === 'server/discover';
            if (!isDiscoverProbe && !paymentProvider && !apifyToken) {
                unauthorized = true;
                throw new Error('Apify API token missing on unauthenticated request');
            }
            const mcpServer = new ActorsMcpServer({
                taskStore,
                setupSigintHandler: false,
                transportType: 'http',
                telemetry: { enabled: telemetryEnabled },
                serverMode,
                paymentProvider,
                token: apifyToken,
                clientParam,
            });
            // No initialize handshake, so this fetch carries no request-origin tag.
            if (!isDiscoverProbe) {
                await mcpServer.loadToolsFromUrl(req.url, new ApifyClient({ token: apifyToken }));
            }
            return createStatelessServer(mcpServer, req.url);
        },
        {
            legacy: 'reject',
            onerror: (error) =>
                log.softFail('Stateless MCP request rejected', { errMessage: sanitizeMezmoMessage(error.message) }),
        },
    );
    try {
        // The entry never derives `authInfo` from headers itself; pass the extracted token through
        // for handlers to read as `ctx.http.authInfo`. No OAuth client here, hence empty `clientId`.
        if (apifyToken) {
            (req as Request & { auth?: AuthInfo }).auth = { token: apifyToken, clientId: '', scopes: [] };
        }
        // The factory's throw surfaces from the entry as a 500; swap in the 401 the auth gate owns.
        await toNodeHandler({
            ...handler,
            fetch: async (request, options) => {
                const response = await handler.fetch(request, options);
                if (!unauthorized) return response;
                log.softFail('Apify API token missing on unauthenticated request', { statusCode: 401 });
                return Response.json(UNAUTHORIZED_RESPONSE_BODY, {
                    status: 401,
                    headers: { 'WWW-Authenticate': UNAUTHORIZED_CHALLENGE },
                });
            },
        })(req, res, req.body);
    } finally {
        await handler.close();
    }
}

export function createExpressApp(): express.Express {
    const app = express();
    const transports = new Map<string, StreamableHTTPServerTransport>();
    const taskStore = new InMemoryTaskStore();
    const validateHost = localhostHostValidation();
    const validateOrigin = localhostOriginValidation();

    function respondWithError(res: Response, error: unknown, logMessage: string) {
        log.exception(toPlainError(error), 'Error in request', { logMessage, statusCode: 500 });
        if (!res.headersSent) {
            res.status(500).json(buildJsonRpcError(-32603, 'Internal server error'));
        }
    }

    // DNS-rebinding protection, before parsing any body: reject non-local Host headers (a rebound
    // hostname resolves here without a browser Origin) and non-local Origins. See apify/apify-mcp-server#1140.
    app.use((req, res, next) => {
        if (validateHost(req, res) && validateOrigin(req, res)) next();
    });

    // Express's 100 KB default is too small for tool calls that carry files. See apify/apify-mcp-server#1610.
    app.use(express.json({ limit: MAX_REQUEST_BODY_BYTES }));
    app.post('/', async (req: Request, res: Response) => {
        log.info('Received MCP request:', req.body);
        try {
            if (await isStatelessRequest(req)) {
                await serveStatelessRequest(req, res, taskStore);
                return;
            }

            const sessionId = req.headers['mcp-session-id'] as string | undefined;
            if (sessionId) {
                const transport = transports.get(sessionId);
                if (!transport) {
                    res.status(404).json(buildJsonRpcError(-32001, 'Session not found'));
                    return;
                }
                if (req.body) {
                    req.body.params = injectMcpSessionId(req.body.params, sessionId);
                }
                await transport.handleRequest(req, res, req.body);
                return;
            }

            const initializeMessage = extractInitializeMessage(req.body);
            if (!initializeMessage) {
                res.status(400).json(buildJsonRpcError(-32000, 'Bad Request: Mcp-Session-Id header is required'));
                return;
            }

            const { telemetryEnabled, serverMode, paymentProvider, clientParam } = await parseUrlParams(req);
            const auth = resolveRequestAuth(req, res, paymentProvider);
            if (!auth) return;
            const { apifyToken } = auth;

            const mcpServer = new ActorsMcpServer({
                taskStore,
                setupSigintHandler: false,
                transportType: 'http',
                telemetry: { enabled: telemetryEnabled },
                serverMode,
                paymentProvider,
                token: apifyToken,
                clientParam,
            });

            const requestOrigin = getRequestOriginForClient(
                buildMcpClientContext(parseInitializeParams(initializeMessage.params)),
            );
            // Tools are composed with the final server mode inside the initialize handler.
            await mcpServer.loadToolsFromUrl(req.url, new ApifyClient({ token: apifyToken, requestOrigin }));

            // The SDK awaits onsessioninitialized before sending InitializeResult, so the session is
            // registered before any follow-up request can arrive.
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                enableJsonResponse: false,
                onsessioninitialized: (newSessionId) => {
                    transports.set(newSessionId, transport);
                },
                onsessionclosed: (closedSessionId) => {
                    transports.delete(closedSessionId);
                },
            });

            await mcpServer.connect(transport);
            await transport.handleRequest(req, res, req.body);
        } catch (error) {
            respondWithError(res, error, 'Error handling MCP request');
        }
    });

    // GET opens the stream for server-initiated notifications not tied to a POST (e.g.
    // notifications/tasks/status); without it the transport drops them. DELETE ends the session.
    async function handleSessionRequest(req: Request, res: Response) {
        if (isSessionlessEraRequest(req)) {
            res.set('Allow', 'POST').status(405).json(buildJsonRpcError(-32000, 'Method not allowed.'));
            return;
        }
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        const transport = sessionId ? transports.get(sessionId) : undefined;
        if (!transport) {
            log.softFail('Session not found', { mth: req.method, mcpSessionId: sessionId, statusCode: 404 });
            res.status(404).send('Not Found: Session not found');
            return;
        }
        log.info('MCP API', { mth: req.method, rt: '/', mcpSessionId: sessionId });
        try {
            await transport.handleRequest(req, res, req.body);
        } catch (error) {
            respondWithError(res, error, `Error handling ${req.method} request`);
        }
    }
    app.get('/', handleSessionRequest);
    app.delete('/', handleSessionRequest);

    app.use((req: Request, res: Response) => {
        res.status(404).json({ message: `There is nothing at route ${req.method} ${req.originalUrl}.` });
    });

    return app;
}

/**
 * Finds the `initialize` message in a (possibly batched) request body by `method` tag alone.
 * Deliberately loose: a body with malformed `params` must still enter the initialize branch so the
 * SDK's schema validation produces the accurate protocol error instead of the generic 400.
 */
export function extractInitializeMessage(body: unknown): { method: string; params?: unknown } | undefined {
    const messages = Array.isArray(body) ? body : [body];
    return messages.find(
        (msg): msg is { method: string; params?: unknown } =>
            typeof msg === 'object' && msg !== null && (msg as { method?: unknown }).method === 'initialize',
    );
}

/** Malformed params parse to `undefined`; the SDK validates the full request itself. */
export function parseInitializeParams(params: unknown): InitializeRequestParams | undefined {
    const result = InitializeRequestParamsSchema.safeParse(params);
    return result.success ? result.data : undefined;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const HOST = process.env.HOST ?? 'http://localhost';
    const PORT = Number(process.env.PORT) || 3001;

    const app = createExpressApp();

    app.listen(PORT, '127.0.0.1', () => {
        log.info('MCP server listening', { host: HOST, port: PORT });
    });

    process.on('SIGINT', () => {
        log.info('Received SIGINT, shutting down gracefully...');
        process.exit(0);
    });
}
