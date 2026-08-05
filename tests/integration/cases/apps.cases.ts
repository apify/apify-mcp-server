import { expect, it } from 'vitest';

import { HELPER_TOOLS, SERVER_MODE_AUTO_DETECTION_ENABLED } from '../../../src/const.js';
import { RESOURCE_MIME_TYPE } from '../../../src/resources/widgets.js';
import { ACTOR_NORMAL_MODE } from '../../const.js';
import type { McpSuiteClient } from '../../helpers.js';
import { type CasesCtx, expectWidgetToolMeta, getToolNames } from './shared.js';

/**
 * Apps-mode widget tools: `*-widget` structuredContent shape and `_meta.ui` metadata,
 * plus auto server-mode detection from client capabilities.
 */
export function registerAppsCases(ctx: CasesCtx): void {
    const { itc, createClientFn } = ctx;

    itc(
        'should render widget payload via fetch-actor-details-widget in apps mode',
        {
            tools: ['actors'],
            serverMode: 'apps',
        },
        async (client) => {
            // fetch-actor-details-widget is only available in apps mode
            const result = await client.callTool({
                name: 'fetch-actor-details-widget',
                arguments: {
                    actor: ACTOR_NORMAL_MODE,
                },
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
        },
    );

    it.runIf(SERVER_MODE_AUTO_DETECTION_ENABLED)(
        'auto mode: client advertising UI capability receives apps-mode tools with widget metadata',
        async () => {
            let client: McpSuiteClient | undefined;
            try {
                // serverMode omitted → server defaults to 'auto'; client sends UI capability → server resolves to 'apps'
                client = await createClientFn({
                    clientCapabilities: {
                        extensions: {
                            'io.modelcontextprotocol/ui': { mimeTypes: [RESOURCE_MIME_TYPE] },
                        },
                    },
                });
                const tools = await client.listTools();
                expectWidgetToolMeta(tools);
            } finally {
                await client?.close();
            }
        },
    );

    {
        // serverMode omitted → server defaults to 'auto'; client sends no UI capability → server resolves to 'default'
        itc(
            'auto mode: client without UI capability receives default-mode tools without widget metadata',
            undefined,
            async (client) => {
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
            },
        );
    }

    itc(
        'should return required structuredContent fields for ActorSearch widget (search-actors-widget)',
        {
            tools: ['actors'],
            serverMode: 'apps', // Enable UI mode to get widgetActors
        },
        async (client) => {
            const result = await client.callTool({
                name: HELPER_TOOLS.STORE_SEARCH_WIDGET,
                arguments: {
                    keywords: 'python',
                    limit: 5,
                },
            });

            const content = result as {
                structuredContent?: {
                    actors: Record<string, unknown>[];
                    widgetActors?: Record<string, unknown>[];
                };
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
        },
    );

    itc(
        'should return required structuredContent fields for ActorSearchDetail widget (fetch-actor-details-widget)',
        {
            tools: ['actors'],
            serverMode: 'apps', // Enable UI mode to get widget structured content
        },
        async (client) => {
            const result = await client.callTool({
                name: HELPER_TOOLS.ACTOR_GET_DETAILS_WIDGET,
                arguments: {
                    actor: ACTOR_NORMAL_MODE,
                },
            });

            const content = result as {
                structuredContent?: {
                    actorDetails?: {
                        actorInfo: {
                            id: string;
                            name: string;
                            username: string;
                            description: string;
                        };
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
        },
    );
}
