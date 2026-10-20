import { describe, expect, it } from 'vitest';

import { CATEGORY_NAMES, getCategoryTools } from '../../src/tools/index.js';
import { ALL_WIDGET_TOOLS, UNCATEGORIZED_TOOLS } from '../../src/tools/registry.js';

type SchemaNode = Record<string, unknown>;

const VALIDATION_KEYWORDS = ['type', 'anyOf', 'oneOf', 'allOf', '$ref', 'enum', 'const'];

/** Returns the paths of subschemas that some MCP clients refuse or mishandle. */
function findNonPortableSubschemas(node: SchemaNode, path: string): string[] {
    const problems: string[] = [];
    if (Array.isArray(node.type)) problems.push(`${path}: type array`);
    if (!VALIDATION_KEYWORDS.some((keyword) => keyword in node)) problems.push(`${path}: no validation keyword`);

    const children: [string, SchemaNode][] = [];
    for (const [name, child] of Object.entries((node.properties ?? {}) as Record<string, SchemaNode>)) {
        children.push([`${path}.properties.${name}`, child]);
    }
    if (typeof node.additionalProperties === 'object') {
        children.push([`${path}.additionalProperties`, node.additionalProperties as SchemaNode]);
    }
    if (typeof node.items === 'object') children.push([`${path}.items`, node.items as SchemaNode]);
    for (const keyword of ['anyOf', 'oneOf', 'allOf']) {
        ((node[keyword] ?? []) as SchemaNode[]).forEach((child, i) =>
            children.push([`${path}.${keyword}[${i}]`, child]),
        );
    }

    for (const [childPath, child] of children) problems.push(...findNonPortableSubschemas(child, childPath));
    return problems;
}

describe('tool schemas', () => {
    it('use no type arrays and no keyword-less subschemas', () => {
        const tools = [
            ...CATEGORY_NAMES.flatMap((name) => getCategoryTools('default')[name]),
            ...CATEGORY_NAMES.flatMap((name) => getCategoryTools('apps')[name]),
            ...ALL_WIDGET_TOOLS,
            ...UNCATEGORIZED_TOOLS,
        ];
        const problems: string[] = [];
        for (const tool of tools) {
            for (const key of ['inputSchema', 'outputSchema'] as const) {
                const schema = tool[key];
                if (!schema) continue;
                problems.push(...findNonPortableSubschemas(schema as SchemaNode, `${tool.name}.${key}`));
            }
        }
        expect([...new Set(problems)]).toEqual([]);
    });
});
