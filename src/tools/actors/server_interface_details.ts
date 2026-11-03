/**
 * The server-interface section of `fetch-actor-details`, built as the `structuredContent` object first and the
 * text from it (a header plus the object as fenced JSON), so the two cannot drift.
 */
import { HELPER_TOOLS, MAX_INLINE_BYTES } from '../../const.js';
import type { Actor, ActorTenancy } from '../../types.js';
import { ACTOR_TENANCY } from '../../types.js';
import { wrapJsonText } from '../../utils/encode_text.js';
import { resolveActorTenancy } from '../actor_tool_naming.js';
import type { DereferenceContext } from '../api/apify_api_spec.js';
import { DereferenceBudgetError } from '../api/apify_api_spec.js';
import type { ServerOperation, ServerOperationDetails, ServerOperationIndexEntry } from './server_interface_schema.js';
import {
    buildServerOperationDetails,
    buildServerOperationIndex,
    findServerOperation,
    formatOperationName,
    listServerOperations,
} from './server_interface_schema.js';

/** `structuredContent.serverInterface` of `fetch-actor-details`. */
export type ServerInterfaceDetails = {
    tenancy: ActorTenancy;
    /** Single-tenant: how long the run the first request starts stays up without requests. */
    idleTimeoutSecs?: number;
    /** Only without the send tool, which adds the host itself. */
    baseUrl?: string;
    /** All documented operations, whatever `operations` holds. */
    operationCount: number;
    operations?: ServerOperationDetails[];
    /** Replaces `operations` when they exceed `MAX_INLINE_BYTES` in full. */
    operationIndex?: ServerOperationIndexEntry[];
    omittedOperationCount?: number;
};

export type ServerInterfaceSection = { serverInterface?: ServerInterfaceDetails; text?: string };

const MAX_NAMED_OPERATIONS = 5;
const MAX_NAMED_OPERATIONS_LENGTH = 300;

function formatOperationCount(operations: ServerOperation[]): string {
    const count = `${operations.length} documented operation${operations.length === 1 ? '' : 's'}`;
    const names = operations.map(formatOperationName).join(', ');
    const isNamed = operations.length <= MAX_NAMED_OPERATIONS && names.length <= MAX_NAMED_OPERATIONS_LENGTH;
    return isNamed ? `${count}: ${names}` : count;
}

function formatDetailsCall(actorFullName: string, serverInterface: true | string): string {
    return `${HELPER_TOOLS.ACTOR_GET_DETAILS} with ${JSON.stringify({ actor: actorFullName, output: { serverInterface } })}`;
}

/** `undefined` when the references expand past `maxExpansionBytes`. */
function renderWithinBudget<T>(
    schema: unknown,
    render: (context: DereferenceContext) => T,
    maxExpansionBytes = MAX_INLINE_BYTES,
): { value: T; json: string } | undefined {
    const budget = { remainingBytes: maxExpansionBytes };
    try {
        const value = render({ spec: schema, shouldKeepExamples: true, budget });
        return { value, json: wrapJsonText(value) };
    } catch (error) {
        // A deep untrusted schema or example can exhaust the stack in JSON.stringify.
        if (error instanceof DereferenceBudgetError || error instanceof RangeError) return undefined;
        throw error;
    }
}

/** As many entries as fit `maxBytes`. The size grows with the entries kept, as an entry outweighs a digit of the count. */
function fitOperationIndex(
    facts: ServerInterfaceDetails,
    index: ServerOperationIndexEntry[],
    maxBytes: number,
): { value: ServerInterfaceDetails; json: string } {
    const render = (kept: number) => {
        const omitted = index.length - kept;
        const value = {
            ...facts,
            operationIndex: index.slice(0, kept),
            ...(omitted > 0 && { omittedOperationCount: omitted }),
        };
        return { value, json: wrapJsonText(value) };
    };
    let low = 0;
    let high = index.length;
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (Buffer.byteLength(render(middle).json) <= maxBytes) low = middle;
        else high = middle - 1;
    }
    return render(low);
}

/** An `undefined` section ran out of its rendering budget, so it would not fit either. */
function checkSize(
    section: ServerInterfaceSection | undefined,
    actorFullName: string,
): ServerInterfaceSection | { error: string } {
    if (section?.text !== undefined && Buffer.byteLength(section.text) <= MAX_INLINE_BYTES) return section;
    return {
        error: `Actor '${actorFullName}' server-interface output exceeds the ${MAX_INLINE_BYTES}-byte limit and was not returned. A smaller operation may fit.`,
    };
}

/** The platform facts of the section, the same for every tier that lists operations. */
function buildServerInterfaceFacts(
    actor: Pick<Actor, 'actorStandby' | 'standbyUrl'>,
    tenancy: ActorTenancy,
    operationCount: number,
    canSend: boolean,
): ServerInterfaceDetails {
    const idleTimeoutSecs = actor.actorStandby?.idleTimeoutSecs;
    return {
        tenancy,
        ...(tenancy === ACTOR_TENANCY.SINGLE_TENANT && idleTimeoutSecs !== undefined && { idleTimeoutSecs }),
        ...(!canSend && actor.standbyUrl && { baseUrl: actor.standbyUrl }),
        operationCount,
    };
}

/** What a request costs, by tenancy. */
export function formatServerRequestCost({
    tenancy,
    idleTimeoutSecs,
}: Pick<ServerInterfaceDetails, 'tenancy' | 'idleTimeoutSecs'>): string {
    if (tenancy === ACTOR_TENANCY.MULTI_TENANT) {
        return `${tenancy}: requests are charged per event and start no run in your account.`;
    }
    const idleTimeout = idleTimeoutSecs === undefined ? 'its idle timeout' : `its idle timeout of ${idleTimeoutSecs} s`;
    return `${tenancy}: the first request starts a run in your account, kept for ${idleTimeout}.`;
}

/** What a request costs, from the facts. */
function formatCostNotice(facts: ServerInterfaceDetails, hasPaymentProvider: boolean): string {
    if (hasPaymentProvider) return 'Requests to a server interface are not supported in agentic payment mode.';
    return formatServerRequestCost(facts);
}

function formatSendExample(actorFullName: string, lead: string, { method, path }: ServerOperation): string {
    return `${HELPER_TOOLS.ACTOR_SERVER_REQUEST} sends ${lead}: ${JSON.stringify({ actor: actorFullName, method, path })}\n`;
}

/** What the tiers that list operations share. */
type SectionContext = {
    actorFullName: string;
    schema: unknown;
    facts: ServerInterfaceDetails;
    /** The title, the cost notice and, with the send tool, how to send `operation`. */
    formatHeader: (title: string, lead: string, operation: ServerOperation) => string;
};

/** Every operation in full, or the index when they do not fit. */
function buildOperationsSection(
    { actorFullName, schema, facts, formatHeader }: SectionContext,
    operations: ServerOperation[],
): ServerInterfaceSection | { error: string } {
    const header = formatHeader(`# Server interface of ${actorFullName}`, 'a request to one of them', operations[0]);
    const full = renderWithinBudget(schema, (context) => ({
        ...facts,
        operations: operations.map((operation) => buildServerOperationDetails(operation, context)),
    }));
    if (full) {
        const text = `${header}${full.json}`;
        if (Buffer.byteLength(text) <= MAX_INLINE_BYTES) return { serverInterface: full.value, text };
    }
    const next = `The operations in full exceed the ${MAX_INLINE_BYTES}-byte limit. ${formatDetailsCall(actorFullName, formatOperationName(operations[0]))} returns one operation in full.\n`;
    const index = fitOperationIndex(
        facts,
        buildServerOperationIndex(operations, schema),
        MAX_INLINE_BYTES - Buffer.byteLength(`${header}${next}`),
    );
    return checkSize({ serverInterface: index.value, text: `${header}${next}${index.json}` }, actorFullName);
}

function buildOperationSection(
    { actorFullName, schema, facts, formatHeader }: SectionContext,
    operation: ServerOperation,
): ServerInterfaceSection | { error: string } {
    const header = formatHeader(
        `# Server interface of ${actorFullName}: ${formatOperationName(operation)}`,
        'this request',
        operation,
    );
    const one = renderWithinBudget(schema, (context) => ({
        ...facts,
        operations: [buildServerOperationDetails(operation, context)],
    }));
    return checkSize(one && { serverInterface: one.value, text: `${header}${one.json}` }, actorFullName);
}

/** The section by `output.serverInterface`: a summary line, every operation or the index, or one operation. */
export function buildServerInterfaceDetails({
    actor,
    actorFullName,
    schema,
    serverInterface,
    loadedToolNames,
    hasPaymentProvider,
}: {
    actor: Pick<Actor, 'actorStandby' | 'standbyUrl'>;
    actorFullName: string;
    schema: unknown;
    serverInterface: boolean | string;
    loadedToolNames: readonly string[];
    /** An agentic payment provider (x402, Skyfire) cannot pay for a server-interface request. */
    hasPaymentProvider: boolean;
}): ServerInterfaceSection | { error: string } {
    const hasSendTool = loadedToolNames.includes(HELPER_TOOLS.ACTOR_SERVER_REQUEST);
    // The summary helps choose between call-actor and the send tool, so it follows the send tool.
    if (serverInterface === false && !hasSendTool) return {};
    if (actor.actorStandby?.isEnabled !== true) {
        return serverInterface === false ? {} : { text: `Actor '${actorFullName}' has no server interface.` };
    }
    const tenancy = resolveActorTenancy(actor);
    const operations = listServerOperations(schema);
    if (operations.length === 0) {
        return {
            serverInterface: { tenancy, operationCount: 0 },
            text: `Server interface: enabled, ${tenancy}, undocumented: no API schema. See the README.`,
        };
    }
    const listsThem = `${formatDetailsCall(actorFullName, true)} lists them.`;
    if (serverInterface === false) {
        return {
            serverInterface: { tenancy, operationCount: operations.length },
            text: `Server interface: enabled, ${tenancy}, ${formatOperationCount(operations)}. ${listsThem}`,
        };
    }

    const canSend = !hasPaymentProvider && hasSendTool;
    const facts = buildServerInterfaceFacts(actor, tenancy, operations.length, canSend);
    const notice = formatCostNotice(facts, hasPaymentProvider);
    const context: SectionContext = {
        actorFullName,
        schema,
        facts,
        formatHeader: (title, lead, operation) =>
            `${title}\n${notice}\n${canSend ? formatSendExample(actorFullName, lead, operation) : ''}`,
    };
    if (serverInterface === true) return buildOperationsSection(context, operations);
    const operation = findServerOperation(operations, serverInterface);
    if (!operation) {
        return {
            error: `Actor '${actorFullName}' has no operation "${serverInterface}". ${formatOperationCount(operations)}. ${listsThem}`,
        };
    }
    return buildOperationSection(context, operation);
}
