import { describe, expect, it } from 'vitest';

import { HelperTools } from '../../src/const.js';
import { callActorDefault } from '../../src/tools/actors/call_actor.js';
import { fetchActorDetails } from '../../src/tools/actors/fetch_actor_details.js';
import { searchActors } from '../../src/tools/actors/search_actors.js';
import { shareFeedback } from '../../src/tools/feedback/share_feedback.js';
import type { HelperTool } from '../../src/types.js';
import { type TextToolResult, stubToolCallContext } from './helpers/tool_context.js';

describe('shareFeedback', () => {
    describe('call()', () => {
        it('acknowledges a submission that has a message', async () => {
            const result = await (shareFeedback as HelperTool).call(
                stubToolCallContext({ message: 'The search-actors results were unclear.' }, {} as never),
            );
            const { content, isError } = result as TextToolResult;

            expect(isError).toBe(false);
            expect(content[0].text).toContain('Feedback submitted');
        });
    });

    describe('input validation', () => {
        const validate = (shareFeedback as HelperTool).ajvValidate;

        it('requires a message', () => {
            expect(validate({})).toBe(false);
        });

        it('rejects an npsRating above 10', () => {
            expect(validate({ message: 'stuck', npsRating: 11 })).toBe(false);
        });

        it('rejects an npsRating below 0', () => {
            expect(validate({ message: 'stuck', npsRating: -1 })).toBe(false);
        });

        it('accepts the optional actor, run, rating, and related-tools fields', () => {
            expect(
                validate({
                    message: 'rag-web-browser worked well',
                    actorId: 'apify/rag-web-browser',
                    actorRunId: 'abc123',
                    npsRating: 9,
                    relatedTools: ['call-actor', 'get-dataset-items'],
                }),
            ).toBe(true);
        });
    });

    describe('discoverability', () => {
        it.each([
            ['search-actors', searchActors],
            ['fetch-actor-details', fetchActorDetails],
            ['call-actor', callActorDefault],
        ])('advertises share-feedback in the %s description', (_name, tool) => {
            expect(tool.description).toContain(HelperTools.FEEDBACK_SHARE);
        });
    });
});
