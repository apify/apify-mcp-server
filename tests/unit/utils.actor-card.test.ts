import type { Actor } from 'apify-client';
import { describe, expect, it } from 'vitest';

import type { ActorStoreList } from '../../src/types.js';
import { formatActorToActorCard, formatActorToStructuredCard } from '../../src/utils/actor-card.js';

// Mock Actor data for testing (based on real apify/rag-web-browser Actor)
const mockActor: Actor = {
    id: '3ox4R101TgZz67sLr',
    userId: 'ZscMwFR5H7eCtWtyh',
    name: 'rag-web-browser',
    username: 'apify',
    title: 'RAG Web Browser',
    description: 'Web browser for OpenAI Assistants, RAG pipelines, or AI agents, similar to a web browser in ChatGPT.',
    isPublic: true,
    createdAt: new Date('2024-09-11T19:41:07.795Z'),
    modifiedAt: new Date('2025-11-27T09:32:06.582Z'),
    isDeprecated: false,
    categories: ['AI', 'OPEN_SOURCE'],
    stats: {
        totalBuilds: 100,
        totalRuns: 934350,
        totalUsers: 8594,
        totalUsers7Days: 370,
        totalUsers30Days: 904,
        totalUsers90Days: 1747,
        lastRunStartedAt: new Date('2026-01-08T14:12:41.259Z'),
        publicActorRunStats30Days: {
            ABORTED: 185,
            FAILED: 37,
            SUCCEEDED: 68663,
            'TIMED-OUT': 403,
            TOTAL: 69395,
        },
        actorReviewCount: 14,
        actorReviewRating: 4.94598340350167,
        bookmarkCount: 170,
    },
    pricingInfos: [
        {
            pricingModel: 'PER_ACTOR_RUN',
            pricePerUnitUsd: 0.25,
            startedAt: new Date('2023-01-01T00:00:00Z'),
        },
    ],
} as unknown as Actor;

const mockActorStoreList: ActorStoreList = {
    id: 'actor456',
    name: 'store-actor',
    username: 'community',
    title: 'Store Actor',
    description: 'A store listing actor for testing',
    isDeprecated: false,
    modifiedAt: new Date('2024-02-20T15:30:00Z'),
    categories: ['WEB_SCRAPING', 'AI'],
    actorReviewRating: 4.5,
    bookmarkCount: 250,
    currentPricingInfo: {
        pricingModel: 'PRICE_PER_DATASET_ITEM',
        pricePerUnitUsd: 0.5,
    },
    stats: {
        totalBuilds: 10,
        totalRuns: 10,
        totalUsers: 2000,
        totalUsers30Days: 800,
        bookmarkCount: 250,
        actorReviewCount: 14,
        actorReviewRating: 4.5,
        publicActorRunStats30Days: {
            SUCCEEDED: 85,
            TOTAL: 100,
        },
    },
} as unknown as ActorStoreList;

const mockDeprecatedActor: Actor = {
    ...mockActor,
    id: 'deprecated123',
    name: 'deprecated-actor',
    title: 'Deprecated RAG Browser',
    isDeprecated: true,
} as unknown as Actor;

describe('formatActorToActorCard', () => {
    describe('backwards compatibility (no options)', () => {
        it('should include all sections when no options are provided', () => {
            const result = formatActorToActorCard(mockActor);

            // Should include title and URL (always present)
            expect(result).toContain('## [RAG Web Browser](https://apify.com/apify/rag-web-browser)');
            expect(result).toContain('- **URL:** https://apify.com/apify/rag-web-browser');

            // Should include description text
            expect(result).toContain('- **Description:** Web browser for OpenAI Assistants, RAG pipelines');

            // Should include pricing
            expect(result).toContain('- **[Pricing](https://apify.com/apify/rag-web-browser/pricing):**');

            // Should include stats
            expect(result).toContain('- **Stats:**');
            expect(result).toContain('8,594 total users');
            expect(result).toContain('904 monthly users');

            // Should include rating (from stats)
            expect(result).toContain('- **Rating:** 4.95 out of 5');

            // Should include metadata (developer, categories, modified date)
            expect(result).toContain('- **Developed by:** [apify](https://apify.com/apify) (Apify)');
            expect(result).toContain('- **Categories:** AI, Open Source');
            expect(result).toContain('- **Last modified:** 2025-11-27T09:32:06.582Z');
        });

        it('should include deprecation warning for deprecated actors', () => {
            const result = formatActorToActorCard(mockDeprecatedActor);
            expect(result).toContain('>This Actor is deprecated and may not be maintained anymore.');
        });

        it('should include rating for ActorStoreList', () => {
            const result = formatActorToActorCard(mockActorStoreList);
            expect(result).toContain('- **Rating:** 4.50 out of 5');
        });

        it('should include categories for ActorStoreList', () => {
            const result = formatActorToActorCard(mockActorStoreList);
            expect(result).toContain('- **Categories:** Web Scraping, AI');
        });
    });

    describe('granular options - includeDescription', () => {
        it('should include only title and URL when all options are false', () => {
            const result = formatActorToActorCard(mockActor, {
                includeDescription: false,
                includeStats: false,
                includePricing: false,
                includeRating: false,
                includeMetadata: false,
            });

            // Should include title and URL
            expect(result).toContain('## [RAG Web Browser](https://apify.com/apify/rag-web-browser)');
            expect(result).toContain('- **URL:** https://apify.com/apify/rag-web-browser');

            // Should NOT include description section
            expect(result).not.toContain('- **Developed by:**');
            expect(result).not.toContain('- **Description:**');
            expect(result).not.toContain('- **Categories:**');

            // Should NOT include other sections
            expect(result).not.toContain('- **Pricing');
            expect(result).not.toContain('- **Stats:**');
            expect(result).not.toContain('- **Rating:**');
            expect(result).not.toContain('- **Last modified:**');
        });

        it('should include only description text when includeDescription is true', () => {
            const result = formatActorToActorCard(mockActor, {
                includeDescription: true,
                includeStats: false,
                includePricing: false,
                includeRating: false,
                includeMetadata: false,
            });

            expect(result).toContain('- **Description:** Web browser for OpenAI Assistants');
            expect(result).not.toContain('- **Developed by:**');
            expect(result).not.toContain('- **Categories:**');
            expect(result).not.toContain('- **Stats:**');
            expect(result).not.toContain('- **Pricing');
            expect(result).not.toContain('- **Last modified:**');
        });
    });

    describe('granular options - includeStats', () => {
        it('should include only stats when includeStats is true', () => {
            const result = formatActorToActorCard(mockActor, {
                includeDescription: false,
                includeStats: true,
                includePricing: false,
                includeRating: false,
                includeMetadata: false,
            });

            expect(result).toContain('- **Stats:**');
            expect(result).toContain('8,594 total users');
            expect(result).not.toContain('- **Developed by:**');
            expect(result).not.toContain('- **Pricing');
        });

        it('should include success rate in stats', () => {
            const result = formatActorToActorCard(mockActor, {
                includeDescription: false,
                includeStats: true,
                includePricing: false,
                includeRating: false,
                includeMetadata: false,
            });

            // Success rate: 68663/69395 = 98.9%
            expect(result).toContain('Runs succeeded: 98.9%');
        });

        it('should include bookmark count from Actor.stats', () => {
            const result = formatActorToActorCard(mockActor, {
                includeDescription: false,
                includeStats: true,
                includePricing: false,
                includeRating: false,
                includeMetadata: false,
            });

            expect(result).toContain('170 bookmarks');
        });
    });

    describe('granular options - includePricing', () => {
        it('should include only pricing when includePricing is true', () => {
            const result = formatActorToActorCard(mockActor, {
                includeDescription: false,
                includeStats: false,
                includePricing: true,
                includeRating: false,
                includeMetadata: false,
            });

            expect(result).toContain('- **[Pricing](https://apify.com/apify/rag-web-browser/pricing):**');
            expect(result).not.toContain('- **Stats:**');
            expect(result).not.toContain('- **Developed by:**');
        });
    });

    describe('granular options - includeRating', () => {
        it('should include rating when includeRating is true for ActorStoreList', () => {
            const result = formatActorToActorCard(mockActorStoreList, {
                includeDescription: false,
                includeStats: false,
                includePricing: false,
                includeRating: true,
                includeMetadata: false,
            });

            expect(result).toContain('- **Rating:** 4.50 out of 5');
            expect(result).not.toContain('- **Stats:**');
        });

        it('should not include rating when includeRating is false', () => {
            const result = formatActorToActorCard(mockActorStoreList, {
                includeDescription: false,
                includeStats: false,
                includePricing: false,
                includeRating: false,
                includeMetadata: false,
            });

            expect(result).not.toContain('- **Rating:**');
        });
    });

    describe('granular options - includeMetadata', () => {
        it('should include metadata (developer, categories, modified date) when includeMetadata is true', () => {
            const result = formatActorToActorCard(mockActor, {
                includeDescription: false,
                includeStats: false,
                includePricing: false,
                includeRating: false,
                includeMetadata: true,
            });

            expect(result).toContain('- **Developed by:** [apify](https://apify.com/apify) (Apify)');
            expect(result).toContain('- **Categories:** AI, Open Source');
            expect(result).toContain('- **Last modified:** 2025-11-27T09:32:06.582Z');
            expect(result).not.toContain('- **Description:**');
            expect(result).not.toContain('- **Stats:**');
            expect(result).not.toContain('- **Pricing');
        });

        it('should include deprecation warning when includeMetadata is true', () => {
            const result = formatActorToActorCard(mockDeprecatedActor, {
                includeDescription: false,
                includeStats: false,
                includePricing: false,
                includeRating: false,
                includeMetadata: true,
            });

            expect(result).toContain('>This Actor is deprecated and may not be maintained anymore.');
        });

        it('should not include metadata when includeMetadata is false', () => {
            const result = formatActorToActorCard(mockDeprecatedActor, {
                includeDescription: false,
                includeStats: false,
                includePricing: false,
                includeRating: false,
                includeMetadata: false,
            });

            expect(result).not.toContain('- **Last modified:**');
            expect(result).not.toContain('>This Actor is deprecated');
        });
    });

    describe('granular options - combinations', () => {
        it('should include description and pricing only', () => {
            const result = formatActorToActorCard(mockActor, {
                includeDescription: true,
                includeStats: false,
                includePricing: true,
                includeRating: false,
                includeMetadata: false,
            });

            expect(result).toContain('- **Description:**');
            expect(result).toContain('- **[Pricing](https://apify.com/apify/rag-web-browser/pricing):**');
            expect(result).not.toContain('- **Developed by:**');
            expect(result).not.toContain('- **Categories:**');
            expect(result).not.toContain('- **Stats:**');
            expect(result).not.toContain('- **Last modified:**');
        });

        it('should include stats and rating only', () => {
            const result = formatActorToActorCard(mockActorStoreList, {
                includeDescription: false,
                includeStats: true,
                includePricing: false,
                includeRating: true,
                includeMetadata: false,
            });

            expect(result).toContain('- **Stats:**');
            expect(result).toContain('- **Rating:**');
            expect(result).not.toContain('- **Developed by:**');
            expect(result).not.toContain('- **Pricing');
        });
    });
});

describe('formatActorToStructuredCard', () => {
    describe('backwards compatibility (no options)', () => {
        it('should include all fields when no options are provided', () => {
            const result = formatActorToStructuredCard(mockActor);

            // Should always include
            expect(result.title).toBe('RAG Web Browser');
            expect(result.url).toBe('https://apify.com/apify/rag-web-browser');
            expect(result.fullName).toBe('apify/rag-web-browser');

            // Should include description text
            expect(result.description).toContain('Web browser for OpenAI Assistants');

            // Should include pricing
            expect(result.pricing).toBeDefined();
            expect(result.pricing.model).toBe('PER_ACTOR_RUN');

            // Should include stats
            expect(result.stats).toBeDefined();
            expect(result.stats?.totalUsers).toBe(8594);
            expect(result.stats?.monthlyUsers).toBe(904);

            // Should include rating
            expect(result.rating.average).toBe(4.94598340350167);
            expect(result.rating.count).toBe(14);

            // Should include metadata (developer, categories, dates, deprecation)
            expect(result.developer.username).toBe('apify');
            expect(result.developer.isOfficialApify).toBe(true);
            expect(result.categories).toEqual(['AI', 'Open Source']);
            expect(result.modifiedAt).toBe('2025-11-27T09:32:06.582Z');
            expect(result.isDeprecated).toBe(false);
        });

        it('should include rating for ActorStoreList', () => {
            const result = formatActorToStructuredCard(mockActorStoreList);
            expect(result.rating.average).toBe(4.5);
        });
    });

    describe('granular options - includeDescription', () => {
        it('should exclude description section when includeDescription is false', () => {
            const result = formatActorToStructuredCard(mockActor, {
                includeDescription: false,
                includeStats: false,
                includePricing: false,
                includeRating: false,
                includeMetadata: false,
            });

            // Should always include
            expect(result.title).toBe('RAG Web Browser');
            expect(result.url).toBe('https://apify.com/apify/rag-web-browser');
            expect(result.fullName).toBe('apify/rag-web-browser');

            // Should have empty/default values for description section
            expect(result.developer.username).toBe('');
            expect(result.description).toBe('');
            expect(result.categories).toEqual([]);
        });

        it('should include only description text when includeDescription is true', () => {
            const result = formatActorToStructuredCard(mockActor, {
                includeDescription: true,
                includeStats: false,
                includePricing: false,
                includeRating: false,
                includeMetadata: false,
            });

            expect(result.description).toContain('Web browser for OpenAI Assistants');
            expect(result.developer.username).toBe(''); // Default value, not filled
            expect(result.categories).toEqual([]); // Default value, not filled
            expect(result.stats).toBeUndefined();
        });
    });

    describe('granular options - includeStats', () => {
        it('should exclude stats when includeStats is false', () => {
            const result = formatActorToStructuredCard(mockActor, {
                includeDescription: false,
                includeStats: false,
                includePricing: false,
                includeRating: false,
                includeMetadata: false,
            });

            expect(result.stats).toBeUndefined();
        });

        it('should include stats when includeStats is true', () => {
            const result = formatActorToStructuredCard(mockActor, {
                includeDescription: false,
                includeStats: true,
                includePricing: false,
                includeRating: false,
                includeMetadata: false,
            });

            expect(result.stats).toBeDefined();
            expect(result.stats?.totalUsers).toBe(8594);
            expect(result.stats?.monthlyUsers).toBe(904);
            expect(result.stats?.successRate).toBe(98.9);
        });

        it('should include bookmarks from Actor.stats', () => {
            const result = formatActorToStructuredCard(mockActor, {
                includeDescription: false,
                includeStats: true,
                includePricing: false,
                includeRating: false,
                includeMetadata: false,
            });

            expect(result.stats?.bookmarks).toBe(170);
        });
    });

    describe('granular options - includePricing', () => {
        it('should include default pricing when includePricing is false', () => {
            const result = formatActorToStructuredCard(mockActor, {
                includeDescription: false,
                includeStats: false,
                includePricing: false,
                includeRating: false,
                includeMetadata: false,
            });

            // Should have default pricing
            expect(result.pricing.model).toBe('FREE');
            expect(result.pricing.isFree).toBe(true);
        });

        it('should include actual pricing when includePricing is true', () => {
            const result = formatActorToStructuredCard(mockActor, {
                includeDescription: false,
                includeStats: false,
                includePricing: true,
                includeRating: false,
                includeMetadata: false,
            });

            expect(result.pricing.model).toBe('PER_ACTOR_RUN');
            expect(result.pricing.isFree).toBe(false);
        });
    });

    describe('granular options - includeRating', () => {
        it('should exclude rating when includeRating is false', () => {
            const result = formatActorToStructuredCard(mockActorStoreList, {
                includeDescription: false,
                includeStats: false,
                includePricing: false,
                includeRating: false,
                includeMetadata: false,
            });

            expect(result.rating).toBeUndefined();
        });

        it('should include rating when includeRating is true', () => {
            const result = formatActorToStructuredCard(mockActorStoreList, {
                includeDescription: false,
                includeStats: false,
                includePricing: false,
                includeRating: true,
                includeMetadata: false,
            });

            expect(result.rating.average).toBe(4.5);
            expect(result.rating.count).toBe(14);
        });
    });

    describe('granular options - includeMetadata', () => {
        it('should exclude metadata when includeMetadata is false', () => {
            const result = formatActorToStructuredCard(mockDeprecatedActor, {
                includeDescription: false,
                includeStats: false,
                includePricing: false,
                includeRating: false,
                includeMetadata: false,
            });

            expect(result.modifiedAt).toBeUndefined();
            expect(result.isDeprecated).toBe(false); // Default value
        });

        it('should include metadata (developer, categories, dates, deprecation) when includeMetadata is true', () => {
            const result = formatActorToStructuredCard(mockDeprecatedActor, {
                includeDescription: false,
                includeStats: false,
                includePricing: false,
                includeRating: false,
                includeMetadata: true,
            });

            expect(result.developer.username).toBe('apify');
            expect(result.developer.isOfficialApify).toBe(true);
            expect(result.categories).toEqual(['AI', 'Open Source']);
            expect(result.modifiedAt).toBe('2025-11-27T09:32:06.582Z');
            expect(result.isDeprecated).toBe(true);
        });
    });

    describe('granular options - combinations', () => {
        it('should include only requested sections (description + pricing)', () => {
            const result = formatActorToStructuredCard(mockActor, {
                includeDescription: true,
                includeStats: false,
                includePricing: true,
                includeRating: false,
                includeMetadata: false,
            });

            expect(result.description).toContain('Web browser for OpenAI Assistants');
            expect(result.pricing.model).toBe('PER_ACTOR_RUN');
            expect(result.developer.username).toBe(''); // Not included (metadata is false)
            expect(result.categories).toEqual([]); // Not included (metadata is false)
            expect(result.stats).toBeUndefined();
            expect(result.rating).toBeUndefined();
            expect(result.modifiedAt).toBeUndefined();
        });

        it('should include only requested sections (stats + rating)', () => {
            const result = formatActorToStructuredCard(mockActorStoreList, {
                includeDescription: false,
                includeStats: true,
                includePricing: false,
                includeRating: true,
                includeMetadata: false,
            });

            expect(result.stats).toBeDefined();
            expect(result.rating.average).toBe(4.5);
            expect(result.rating.count).toBe(14);
            expect(result.developer.username).toBe('');
            expect(result.modifiedAt).toBeUndefined();
        });
    });
});
