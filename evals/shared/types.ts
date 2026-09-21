/**
 * Shared type definitions for evaluation systems
 */

/**
 * Base test case interface - common fields for all test types
 */
export type BaseTestCase = {
    /** Unique test case ID */
    id: string;
    /** Category for grouping (e.g., "search-actors", "call-actor", "fetch-actor-details") */
    category: string;
    /** User query/prompt */
    query: string;
    /** Reference instructions or requirements */
    reference?: string;
};
