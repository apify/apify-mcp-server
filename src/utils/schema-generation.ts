import toJsonSchema from 'to-json-schema';

/**
 * Minimal JSON Schema typings for array/object schemas used in generateSchemaFromItems
 */
export type JsonSchemaProperty = {
    type: 'string' | 'integer' | 'number' | 'boolean' | 'object' | 'array' | 'null';
    properties?: Record<string, JsonSchemaProperty>;
    items?: JsonSchemaProperty;
};

export interface JsonSchemaObject {
    type: 'object';
    properties: Record<string, JsonSchemaProperty>;
}

export interface JsonSchemaArray {
    type: 'array';
    items: JsonSchemaObject | JsonSchemaProperty;
}

/**
 * Options for schema generation
 */
export interface SchemaGenerationOptions {
    /** Maximum number of items to use for schema generation. Default is 5. */
    limit?: number;
    /** If true, uses only non-empty items and skips hidden fields. Default is true. */
    clean?: boolean;
    /** Strategy for handling arrays. "first" uses first item as template, "all" merges all items. Default is "all". */
    arrayMode?: 'first' | 'all';
}

/**
 * Function to recursively remove empty arrays from an object
 */
export function removeEmptyArrays(obj: unknown): unknown {
    if (Array.isArray(obj)) {
        // If the item is an array, recursively call removeEmptyArrays on each element.
        return obj.map((item) => removeEmptyArrays(item));
    }

    if (typeof obj !== 'object' || obj === null) {
        // Return primitives and null values as is.
        return obj;
    }

    // Use reduce to build a new object, excluding keys with empty arrays.
    return Object.entries(obj).reduce((acc, [key, value]) => {
        const processedValue = removeEmptyArrays(value);

        // Exclude the key if the processed value is an empty array.
        if (Array.isArray(processedValue) && processedValue.length === 0) {
            return acc;
        }

        acc[key] = processedValue;
        return acc;
    }, {} as Record<string, unknown>);
}

// TODO: write unit tests for this.
/**
 * Generates a JSON schema from dataset items with configurable options
 *
 * @param datasetItems - Array of dataset items to generate schema from
 * @param options - Configuration options for schema generation
 * @returns JSON schema object or null if generation fails
 */
export function generateSchemaFromItems(
    datasetItems: unknown[],
    options: SchemaGenerationOptions = {},
): JsonSchemaArray | null {
    const {
        limit = 5,
        clean = true,
        arrayMode = 'all',
    } = options;

    // Limit the number of items used for schema generation
    const itemsToUse = datasetItems.slice(0, limit);

    if (itemsToUse.length === 0) {
        return null;
    }

    // Clean the dataset items by removing empty arrays if requested
    const processedItems = clean
        ? itemsToUse.map((item) => removeEmptyArrays(item))
        : itemsToUse;

    // Try to generate schema with full options first
    try {
        const schema = toJsonSchema(processedItems, {
            arrays: { mode: arrayMode },
        }) as JsonSchemaArray;
        return schema;
    } catch { /* ignore */ }

    try {
        const fallbackSchema = toJsonSchema(processedItems, {
            arrays: { mode: 'first' },
        }) as JsonSchemaArray;
        return fallbackSchema;
    } catch { /* ignore */ }

    // If all attempts fail, return null
    return null;
}
