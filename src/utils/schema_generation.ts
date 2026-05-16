// JSON Schema inference and merge for dataset items.

export type JsonSchemaPrimitiveType = 'string' | 'integer' | 'number' | 'boolean' | 'object' | 'array' | 'null';

export type JsonSchemaProperty = {
    type: JsonSchemaPrimitiveType | JsonSchemaPrimitiveType[];
    properties?: Record<string, JsonSchemaProperty>;
    items?: JsonSchemaProperty;
    format?: string;
};

const FORMAT_DETECTORS: [string, RegExp][] = [
    ['date-time', /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})?$/],
    ['date', /^\d{4}-\d{2}-\d{2}$/],
    ['uuid', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i],
    ['email', /^[^\s@]+@[^\s@]+\.[^\s@]+$/],
    ['uri', /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/\S+$/],
];

const detectFormat = (s: string) => FORMAT_DETECTORS.find(([, re]) => re.test(s))?.[0];

function stripEmptyArrays(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(stripEmptyArrays);
    if (!v || typeof v !== 'object') return v;
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
        const p = stripEmptyArrays(val);
        if (!Array.isArray(p) || p.length) out[k] = p;
    }
    return out;
}

function infer(v: unknown): JsonSchemaProperty {
    if (v === null) return { type: 'null' };
    if (Array.isArray(v)) return v.length ? { type: 'array', items: v.map(infer).reduce(merge) } : { type: 'array' };
    if (typeof v === 'object') {
        const properties: Record<string, JsonSchemaProperty> = {};
        for (const [k, val] of Object.entries(v)) properties[k] = infer(val);
        return Object.keys(properties).length ? { type: 'object', properties } : { type: 'object' };
    }
    if (typeof v === 'number') return { type: Number.isInteger(v) && Number.isFinite(v) ? 'integer' : 'number' };
    if (typeof v === 'string') {
        const f = detectFormat(v);
        return f ? { type: 'string', format: f } : { type: 'string' };
    }
    return { type: typeof v as JsonSchemaPrimitiveType };
}

function merge(a: JsonSchemaProperty, b: JsonSchemaProperty): JsonSchemaProperty {
    const at = Array.isArray(a.type) ? a.type : [a.type];
    const bt = Array.isArray(b.type) ? b.type : [b.type];
    let types = [...new Set([...at, ...bt])];
    if (types.includes('integer') && types.includes('number')) types = types.filter((t) => t !== 'integer');
    const r: JsonSchemaProperty = { type: types.length === 1 ? types[0] : types };
    if (a.format && a.format === b.format) r.format = a.format;
    if (a.properties || b.properties) {
        const ap = a.properties ?? {};
        const bp = b.properties ?? {};
        const merged: Record<string, JsonSchemaProperty> = {};
        for (const k of new Set([...Object.keys(ap), ...Object.keys(bp)])) {
            merged[k] = ap[k] && bp[k] ? merge(ap[k], bp[k]) : (ap[k] ?? bp[k])!;
        }
        if (Object.keys(merged).length) r.properties = merged;
    }
    if (a.items || b.items) r.items = a.items && b.items ? merge(a.items, b.items) : (a.items ?? b.items)!;
    return r;
}

export function generateSchemaFromItems(
    items: unknown[],
    options: { limit?: number; clean?: boolean } = {},
): { type: 'array'; items: JsonSchemaProperty } | null {
    const { limit = 5, clean = true } = options;
    const slice = items.slice(0, limit);
    if (!slice.length) return null;
    const processed = clean ? slice.map(stripEmptyArrays) : slice;
    return { type: 'array', items: processed.map(infer).reduce(merge) };
}
