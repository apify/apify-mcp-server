import { describe, expect, it, vi } from 'vitest';

import { fetchActorDetails } from '../../src/tools/actors/fetch_actor_details.js';
import { fetchActorDetailsWidget } from '../../src/tools/widgets/fetch_actor_details_widget.js';
import type { HelperTool } from '../../src/types.js';
import { expectSoftFailInvalidInput, mockApifyClient, stubToolCallContext, textOf } from './helpers/tool_context.js';

describe('rejecting an empty Actor name before fetching details', () => {
    it.each([fetchActorDetails, fetchActorDetailsWidget])(
        '$name rejects whitespace before any API lookup',
        async (tool) => {
            const actorLookup = vi.fn();
            const userLookup = vi.fn();
            const result = await (tool as HelperTool).call(
                stubToolCallContext({ actor: '   ' }, mockApifyClient({ actor: actorLookup, user: userLookup })),
            );

            expectSoftFailInvalidInput(result);
            expect((result.content ?? []).map(textOf).join('\n')).toContain('"actor" must not be empty');
            expect(actorLookup).not.toHaveBeenCalled();
            expect(userLookup).not.toHaveBeenCalled();
        },
    );
});
