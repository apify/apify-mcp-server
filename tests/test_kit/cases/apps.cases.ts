import { expect } from 'vitest';

import {
    HELPER_TOOLS,
    RESOURCE_MIME_TYPE,
    SERVER_MODE_AUTO_DETECTION_ENABLED,
} from '@apify/actors-mcp-server/internals/test-kit.js';

import { ACTOR_NORMAL_MODE, expectWidgetToolMeta, getToolNames, withClient } from '../helpers.js';
import type { Case } from '../types.js';

/** Apps-mode widgets + auto server-mode from client capabilities. */
export const appsCases: Case[] = [
    {
        name: 'should render widget payload via fetch-actor-details-widget in apps mode',
        isDeploymentTest: false,
        run: withClient({ tools: ['actors'], serverMode: 'apps' }, async (client) => {
            // fetch-actor-details-widget is only available in apps mode
            const result = await client.callTool({
                name: 'fetch-actor-details-widget',
                arguments: { actor: ACTOR_NORMAL_MODE },
            });

            expect(result.content).toBeDefined();
            const content = result.content as { text: string }[];
            const allText = content.map((item) => item.text).join('\n');

            // Widget tool returns a short text pointer to the rendered widget
            expect(allText).toContain('Actor information');
            expect(allText).toContain('interactive widget');

            const structured = result.structuredContent as {
                actorDetails?: { actorInfo?: unknown; readme?: string };
            };
            expect(structured.actorDetails).toBeDefined();
            expect(structured.actorDetails!.actorInfo).toBeDefined();
            expect(typeof structured.actorDetails!.readme).toBe('string');
            expect(structured.actorDetails!.readme!.length).toBeGreaterThan(0);
        }),
    },
    {
        name: 'auto mode: client advertising UI capability receives apps-mode tools with widget metadata',
        isDeploymentTest: false,
        skipIf: () => !SERVER_MODE_AUTO_DETECTION_ENABLED,
        // serverMode omitted → server defaults to 'auto'; client sends UI capability → server resolves to 'apps'
        run: withClient(
            {
                clientCapabilities: {
                    extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: [RESOURCE_MIME_TYPE] } },
                },
            },
            async (client) => {
                const tools = await client.listTools();
                expectWidgetToolMeta(tools);
            },
        ),
    },
    {
        // serverMode omitted → server defaults to 'auto'; client sends no UI capability → server resolves to 'default'
        name: 'auto mode: client without UI capability receives default-mode tools without widget metadata',
        isDeploymentTest: false,
        run: withClient(undefined, async (client) => {
            const tools = await client.listTools();
            const toolNames = getToolNames(tools);

            expect(toolNames).not.toContain(HELPER_TOOLS.STORE_SEARCH_WIDGET);
            expect(toolNames).not.toContain(HELPER_TOOLS.ACTOR_GET_DETAILS_WIDGET);
            for (const toolName of [
                HELPER_TOOLS.STORE_SEARCH,
                HELPER_TOOLS.ACTOR_GET_DETAILS,
                HELPER_TOOLS.ACTOR_CALL,
            ]) {
                const tool = tools.tools.find((t) => t.name === toolName);
                expect(tool).toBeDefined();
                expect((tool?._meta as Record<string, unknown> | undefined)?.ui).toBeUndefined();
            }
        }),
    },
    {
        name: 'should return required structuredContent fields for ActorSearch widget (search-actors-widget)',
        isDeploymentTest: false,
        run: withClient({ tools: ['actors'], serverMode: 'apps' }, async (client) => {
            const result = await client.callTool({
                name: HELPER_TOOLS.STORE_SEARCH_WIDGET,
                arguments: { keywords: 'python', limit: 5 },
            });

            const content = result as {
                structuredContent?: { actors: Record<string, unknown>[]; widgetActors?: Record<string, unknown>[] };
            };

            expect(content.structuredContent).toBeDefined();
            expect(Array.isArray(content.structuredContent?.actors)).toBe(true);

            // Check widgetActors presence in apps mode
            expect(Array.isArray(content.structuredContent?.widgetActors)).toBe(true);

            // Check first widget actor for required fields
            if (content.structuredContent!.widgetActors && content.structuredContent!.widgetActors.length > 0) {
                const actor = content.structuredContent!.widgetActors[0];
                expect(actor).toHaveProperty('id');
                expect(actor).toHaveProperty('name');
                expect(actor).toHaveProperty('username');
                expect(actor).toHaveProperty('description');
            }
        }),
    },
    {
        name: 'should return required structuredContent fields for ActorSearchDetail widget (fetch-actor-details-widget)',
        isDeploymentTest: false,
        run: withClient({ tools: ['actors'], serverMode: 'apps' }, async (client) => {
            const result = await client.callTool({
                name: HELPER_TOOLS.ACTOR_GET_DETAILS_WIDGET,
                arguments: { actor: ACTOR_NORMAL_MODE },
            });

            const content = result as {
                structuredContent?: {
                    actorDetails?: {
                        actorInfo: { id: string; name: string; username: string; description: string };
                        actorCard: string;
                        readme: string;
                    };
                };
            };

            expect(content.structuredContent).toBeDefined();
            expect(content.structuredContent?.actorDetails).toBeDefined();

            const details = content.structuredContent!.actorDetails!;
            expect(typeof details.actorCard).toBe('string');

            // Apps widget path always returns full readme
            expect(details.readme).toBeDefined();
            expect(typeof details.readme).toBe('string');

            expect(details.actorInfo).toHaveProperty('id');
            expect(details.actorInfo).toHaveProperty('name');
            expect(details.actorInfo).toHaveProperty('username');
            expect(details.actorInfo).toHaveProperty('description');
        }),
    },
    {
        // call-actor-widget/get-actor-run-widget are not auto-paired (unlike search/details); confirm
        // each still loads and renders its instruction text via explicit ?tools= selection alone.
        name: '?tools=get-actor-run-widget alone: widget tool loads, server instructions carry its paragraph',
        isDeploymentTest: false,
        run: withClient({ tools: ['get-actor-run-widget'], serverMode: 'apps' }, async (client) => {
            const toolNames = getToolNames(await client.listTools());
            expect(toolNames).toContain(HELPER_TOOLS.ACTOR_RUNS_GET_WIDGET);
            expect(toolNames).not.toContain(HELPER_TOOLS.ACTOR_RUNS_GET); // widget-only, no base auto-added

            const instructions = client.getInstructions();
            expect(instructions).toContain('Widget workflow');
            expect(instructions).toContain(HELPER_TOOLS.ACTOR_RUNS_GET_WIDGET);
        }),
    },
    {
        name: '?tools=call-actor,call-actor-widget: call-actor description carries the WIDGET ALTERNATIVE text',
        isDeploymentTest: false,
        run: withClient({ tools: ['call-actor', 'call-actor-widget'], serverMode: 'apps' }, async (client) => {
            const tools = await client.listTools();
            const toolNames = getToolNames(tools);
            expect(toolNames).toContain(HELPER_TOOLS.ACTOR_CALL);
            expect(toolNames).toContain(HELPER_TOOLS.ACTOR_CALL_WIDGET);

            const callActorTool = tools.tools.find((t) => t.name === HELPER_TOOLS.ACTOR_CALL);
            expect(callActorTool?.description).toContain('WIDGET ALTERNATIVE');
            expect(callActorTool?.description).toContain(HELPER_TOOLS.ACTOR_CALL_WIDGET);
        }),
    },
    {
        name: '?tools=call-actor-widget alone: call-actor absent, widget tool still selectable and functional-shaped',
        isDeploymentTest: false,
        run: withClient({ tools: ['call-actor-widget'], serverMode: 'apps' }, async (client) => {
            const toolNames = getToolNames(await client.listTools());
            expect(toolNames).toContain(HELPER_TOOLS.ACTOR_CALL_WIDGET);
            expect(toolNames).not.toContain(HELPER_TOOLS.ACTOR_CALL); // widget-only, no base auto-added

            const instructions = client.getInstructions();
            expect(instructions).not.toContain('WIDGET ALTERNATIVE'); // that bullet lives on call-actor's own description, absent here
        }),
    },
    {
        // Regression: call-actor-widget's own bundle claim used to short-circuit past
        // get-actor-run-widget's exclusion, silently adding get-actor-run to this exact combination.
        name: '?tools=call-actor-widget,get-actor-run-widget: neither base auto-added, run-workflow helpers still load',
        isDeploymentTest: false,
        run: withClient(
            { tools: ['call-actor-widget', 'get-actor-run-widget'], serverMode: 'apps' },
            async (client) => {
                const toolNames = getToolNames(await client.listTools());
                expect(toolNames).toContain(HELPER_TOOLS.ACTOR_CALL_WIDGET);
                expect(toolNames).toContain(HELPER_TOOLS.ACTOR_RUNS_GET_WIDGET);
                expect(toolNames).not.toContain(HELPER_TOOLS.ACTOR_CALL);
                expect(toolNames).not.toContain(HELPER_TOOLS.ACTOR_RUNS_GET);
                expect(toolNames).toContain(HELPER_TOOLS.DATASET_GET_ITEMS);
                expect(toolNames).toContain(HELPER_TOOLS.KEY_VALUE_STORE_RECORD_GET);
                expect(toolNames).toContain(HELPER_TOOLS.ACTOR_RUNS_ABORT);

                const instructions = client.getInstructions();
                expect(instructions).toContain(HELPER_TOOLS.ACTOR_CALL_WIDGET);
                expect(instructions).toContain(HELPER_TOOLS.ACTOR_RUNS_GET_WIDGET);
            },
        ),
    },
    {
        // URIs are literals, not imports from WIDGET_REGISTRY: clients persist these exact strings,
        // so a rename has to fail here instead of silently following the constant.
        name: 'lists widget resources via resources/list in apps mode',
        isDeploymentTest: false,
        run: withClient({ tools: ['actors'], serverMode: 'apps' }, async (client) => {
            const { resources } = await client.listResources();

            for (const uri of ['ui://widget/search-actors.html', 'ui://widget/actor-run.html']) {
                const resource = resources.find((r) => r.uri === uri);
                // listResources skips a widget whose JS file is missing, so this also fails on an unbuilt src/web/dist.
                expect(resource, `missing widget resource ${uri}`).toBeDefined();
                expect(resource?.mimeType).toBe(RESOURCE_MIME_TYPE);
                expect((resource?._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri).toBe(uri);
            }
        }),
    },
    {
        name: 'omits widget resources from resources/list in default mode',
        isDeploymentTest: false,
        run: withClient({ tools: ['actors'] }, async (client) => {
            const { resources } = await client.listResources();
            // Filtered rather than asserted empty: apify-mcp-server-internal's payment provider
            // adds `file://readme.md` to this same listing.
            expect(resources.filter((r) => r.uri.startsWith('ui://'))).toEqual([]);
        }),
    },
    {
        name: 'reads widget HTML via resources/read in apps mode',
        isDeploymentTest: false,
        run: withClient({ tools: ['actors'], serverMode: 'apps' }, async (client) => {
            const result = await client.readResource({ uri: 'ui://widget/search-actors.html' });
            const contents = result.contents[0] as { mimeType?: string; text?: string };

            // A missing widget JS file still resolves, as `text/plain` carrying "is not available".
            // The mimeType assert is what separates a real widget from that placeholder.
            expect(contents.mimeType).toBe(RESOURCE_MIME_TYPE);
            expect(contents.text).toContain('<!DOCTYPE html>');
        }),
    },
];
