import type { IActorInputSchema } from '../types';

export function inputSchemaToMarkdown(inputSchema: IActorInputSchema) {
    const requiredFields = new Set(inputSchema.required || []);

    return `# Input Schema

${inputSchema.description}

${Object.entries(inputSchema.properties).map(([key, value]) => {
        const isRequired = requiredFields.has(key);
        const requiredText = isRequired ? 'required' : 'optional';

        // Handle prefill and default differently
        let suffix = '';
        if (value.prefill !== undefined && !Array.isArray(value.prefill)) {
            suffix = ` prefill:${value.prefill}`;
        } else if (value.default !== undefined) {
            suffix = ` default:${value.default}`;
        }

        const enumText = value.enum ? `options: ${value.enum.map((item) => (item === '' ? '<empty>' : item)).join(', ')}\n` : '';

        const hasValue = value.prefill !== undefined || value.default !== undefined;
        const trailingSpace = hasValue ? '' : ' ';

        return `## \`${key}\` ${requiredText} ${value.type}${suffix}${trailingSpace}
${enumText}${value.description}`;
    }).join('\n\n')}
`;
}
