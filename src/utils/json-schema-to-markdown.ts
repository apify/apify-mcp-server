import type { IActorInputSchema } from '../types';

function visibleEmpty(value: string) {
    return value === '' ? '<empty>' : value;
}

function formatProperty(key: string, value: any, requiredFields: Set<string>, level = 2): string {
    const isRequired = requiredFields.has(key);
    const requiredText = isRequired ? 'required' : 'optional';

    let result = `${'#'.repeat(level)} \`${key}\` ${requiredText} ${value.type}`;

    if (value.format) {
        result += ` format:${value.format}`;
    }

    if (value.prefill !== undefined && !Array.isArray(value.prefill)) {
        result += ' prefill:';
        result += visibleEmpty(String(value.prefill));
    } else if (value.default !== undefined) {
        result += ' default:';
        result += visibleEmpty(String(value.default));
    }

    // Handle nested properties for objects
    if (value.type === 'object' && value.properties) {
        result += '\n';
        const nestedEntries = Object.entries(value.properties);
        for (let i = 0; i < nestedEntries.length; i++) {
            const [nestedKey, nestedValue] = nestedEntries[i];
            result += formatProperty(nestedKey, nestedValue, requiredFields, level + 1);
            if (i < nestedEntries.length - 1) {
                result += '\n';
            }
        }
        return result;
    }

    if (value.enum || value.description) {
        result += '\n';
        if (value.enum) {
            let enumLine = 'options: ';
            enumLine += value.enum.map(visibleEmpty).join(', ');
            result += enumLine;
            result += '\n';
        }
        if (value.description) {
            result += value.description;
        }
    }

    return result;
}

export function jsonSchemaToMarkdown(inputSchema: IActorInputSchema) {
    const requiredFields = new Set(inputSchema.required || []);

    let markdown = '# JSON Schema';
    if (inputSchema.description) {
        markdown += '\n\n';
        markdown += inputSchema.description;
    }
    markdown += '\n\n'; // Add blank line after title/description

    const properties = Object.entries(inputSchema.properties);
    for (let i = 0; i < properties.length; i++) {
        const [key, value] = properties[i];
        markdown += formatProperty(key, value, requiredFields);
        if (i < properties.length - 1) {
            markdown += '\n\n'; // Add blank line between properties
        }
    }

    return markdown;
}
