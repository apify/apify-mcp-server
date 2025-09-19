import type { IActorInputSchema } from '../types';

function visibleEmpty(value: string) {
    return value === '' ? '<empty>' : value;
}

export function inputSchemaToMarkdown(inputSchema: IActorInputSchema) {
    const requiredFields = new Set(inputSchema.required || []);

    let markdown = '# Input Schema';
    if (inputSchema.description) {
        markdown += '\n\n';
        markdown += inputSchema.description;
    }

    for (const [key, value] of Object.entries(inputSchema.properties)) {
        const isRequired = requiredFields.has(key);
        const requiredText = isRequired ? 'required' : 'optional';

        let line = `## \`${key}\` ${requiredText} ${value.type}`;

        if (value.prefill !== undefined && !Array.isArray(value.prefill)) {
            line += ' prefill:';
            line += visibleEmpty(String(value.prefill));
        } else if (value.default !== undefined) {
            line += ' default:';
            line += visibleEmpty(String(value.default));
        }

        markdown += '\n\n';
        markdown += line;
        markdown += '\n';

        if (value.enum) {
            let enumLine = 'options: ';
            enumLine += value.enum.map(visibleEmpty).join(', ');
            markdown += enumLine;
            markdown += '\n';
        }

        markdown += value.description;
    }

    return markdown;
}
