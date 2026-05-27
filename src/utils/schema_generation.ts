// JSON Schema inference and merge for dataset items.

export type JsonSchemaPrimitiveType = 'string' | 'integer' | 'number' | 'boolean' | 'object' | 'array' | 'null';

export type JsonSchemaProperty = {
    type: JsonSchemaPrimitiveType | JsonSchemaPrimitiveType[];
    properties?: Record<string, JsonSchemaProperty>;
    items?: JsonSchemaProperty;
    format?: string;
};

export type JsonSchemaArray = {
    type: 'array';
    items: JsonSchemaProperty;
};

export type SchemaGenerationOptions = {
    /** Maximum number of items to use for schema generation. Default is 5. */
    limit?: number;
    /** If true, strips empty arrays from items before inference. Default is true. */
    clean?: boolean;
};

/**
 * Local counterpart to the dataset API's `clean=true` — empty arrays carry no schema info.
 * Strips only empty arrays; keeps null / '' / empty objects so schema inference still sees those fields.
 * Stricter sibling: {@link cleanEmptyProperties} also strips nullish and empty strings.
 */
export function cleanEmptyArrays(obj: unknown): unknown {
    if (Array.isArray(obj)) {
        return obj.map(cleanEmptyArrays);
    }
    if (typeof obj !== 'object' || obj === null) {
        return obj;
    }
    return Object.entries(obj).reduce(
        (acc, [key, value]) => {
            const processed = cleanEmptyArrays(value);
            if (Array.isArray(processed) && processed.length === 0) {
                return acc;
            }
            acc[key] = processed;
            return acc;
        },
        {} as Record<string, unknown>,
    );
}

/**
 * Cleans empty properties (null, undefined, empty strings, empty arrays, empty objects) from an object.
 * Looser sibling: {@link cleanEmptyArrays} strips only empty arrays.
 * @param obj - The object to clean
 * @returns The cleaned object or undefined if the result is empty
 */
export function cleanEmptyProperties(obj: unknown): unknown {
    if (obj === null || obj === undefined || obj === '') {
        return undefined;
    }

    if (typeof obj !== 'object') {
        return obj;
    }

    if (Array.isArray(obj)) {
        const cleaned = obj.map((item) => cleanEmptyProperties(item)).filter((item) => item !== undefined);
        return cleaned.length > 0 ? cleaned : undefined;
    }

    const cleaned: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
        const cleanedValue = cleanEmptyProperties(value);
        if (cleanedValue !== undefined) {
            cleaned[key] = cleanedValue;
        }
    }

    return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

const FORMAT_DETECTORS: [string, (s: string) => boolean][] = [
    ['date-time', (s) => /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})?$/.test(s)],
    ['date', (s) => /^\d{4}-\d{2}-\d{2}$/.test(s)],
    ['uuid', (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)],
    ['email', (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)],
    ['uri', (s) => /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/\S+$/.test(s)],
];

function detectFormat(value: string): string | undefined {
    for (const [name, test] of FORMAT_DETECTORS) {
        if (test(value)) return name;
    }
    return undefined;
}

function inferType(value: unknown): JsonSchemaPrimitiveType {
    if (value === null || value === undefined) return 'null';
    if (Array.isArray(value)) return 'array';
    if (typeof value === 'number') return Number.isInteger(value) && Number.isFinite(value) ? 'integer' : 'number';
    if (typeof value === 'boolean') return 'boolean';
    if (typeof value === 'string') return 'string';
    return 'object';
}

function inferSchema(value: unknown): JsonSchemaProperty {
    const type = inferType(value);

    if (type === 'object') {
        const entries = Object.entries(value as Record<string, unknown>);
        if (entries.length === 0) return { type: 'object' };
        const properties: Record<string, JsonSchemaProperty> = {};
        for (const [k, v] of entries) {
            properties[k] = inferSchema(v);
        }
        return { type: 'object', properties };
    }

    if (type === 'array') {
        const arr = value as unknown[];
        if (arr.length === 0) return { type: 'array' };
        const merged = arr.map(inferSchema).reduce(mergeSchemas);
        return { type: 'array', items: merged };
    }

    if (type === 'string') {
        const format = detectFormat(value as string);
        return format ? { type: 'string', format } : { type: 'string' };
    }

    return { type };
}

// Merge rules:
//   integer ⊕ number   → number (number is a superset).
//   different types    → type array, e.g. ['string', 'null'].
//   two objects        → union of keys, recursive merge of shared values.
//   two arrays         → merged `items`.
//   string format kept only when both sides agree.
function mergeSchemas(a: JsonSchemaProperty, b: JsonSchemaProperty): JsonSchemaProperty {
    const aTypes = Array.isArray(a.type) ? a.type : [a.type];
    const bTypes = Array.isArray(b.type) ? b.type : [b.type];
    let typeSet = Array.from(new Set([...aTypes, ...bTypes]));

    // integer ⊆ number — collapse to number when both appear.
    if (typeSet.includes('integer') && typeSet.includes('number')) {
        typeSet = typeSet.filter((t) => t !== 'integer');
    }

    const result: JsonSchemaProperty = {
        type: typeSet.length === 1 ? typeSet[0] : typeSet,
    };

    if (a.format && a.format === b.format) {
        result.format = a.format;
    }

    if (a.properties || b.properties) {
        const ap = a.properties ?? {};
        const bp = b.properties ?? {};
        const allKeys = new Set([...Object.keys(ap), ...Object.keys(bp)]);
        if (allKeys.size > 0) {
            const merged: Record<string, JsonSchemaProperty> = {};
            for (const k of allKeys) {
                const av = ap[k];
                const bv = bp[k];
                if (av && bv) merged[k] = mergeSchemas(av, bv);
                else merged[k] = (av ?? bv) as JsonSchemaProperty;
            }
            result.properties = merged;
        }
    }

    if (a.items && b.items) {
        result.items = mergeSchemas(a.items, b.items);
    } else if (a.items || b.items) {
        result.items = (a.items ?? b.items) as JsonSchemaProperty;
    }

    return result;
}

export function generateSchemaFromItems(
    datasetItems: unknown[],
    options: SchemaGenerationOptions = {},
): JsonSchemaArray | null {
    const { limit = 5, clean = true } = options;

    const itemsToUse = datasetItems.slice(0, limit);
    if (itemsToUse.length === 0) return null;

    const processed = clean ? itemsToUse.map(cleanEmptyArrays) : itemsToUse;

    const itemSchemas = processed.map(inferSchema);
    const merged = itemSchemas.reduce(mergeSchemas);

    return { type: 'array', items: merged };
}
