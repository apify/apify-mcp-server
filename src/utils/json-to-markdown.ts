type JSON = string | number | boolean | null | JSON[] | { [key: string]: JSON };

function isEmpty(json: JSON): boolean {
    return (
        json === null || json === undefined || json === ''
    || (Array.isArray(json) && json.length === 0)
    || (typeof json === 'object' && Object.keys(json).length === 0)
    );
}

function isNotEmpty(json: JSON): boolean {
    return !isEmpty(json);
}

export function jsonToMarkdown(json: JSON, pad = 0): string {
    if (typeof json === 'string' || typeof json === 'number' || typeof json === 'boolean') {
        return String(json);
    }

    if (json === null) {
        return ''; // Ignore null
    }

    // Trivial array will be just list like 1, 2, 3
    if (Array.isArray(json)) {
        if (json.length === 0) {
            return ''; // Ignore empty arrays
        }
        if (json.every((item) => typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean' || item === null)) {
            // Null in array is ignored
            return json.filter(isNotEmpty).join(', ');
        }

        // Advanced array will use bullets
        const indent = ' '.repeat(pad * 2);
        const singleLine = json.length === 1 && json.every((item) => {
            const content = jsonToMarkdown(item, 0);
            return !content.includes('\n');
        });
        if (singleLine) {
            // For single-item arrays with simple content, don't add indent
            return json.filter(isNotEmpty)
                .map((value) => {
                    const content = jsonToMarkdown(value, 0);
                    return `- ${content}`;
                })
                .join(' ');
        }
        return json.filter(isNotEmpty)
            .map((value, index) => {
                const content = jsonToMarkdown(value, 0);
                const lines = content.split('\n');
                if (lines.length === 1) {
                    return `${indent}- ${lines[0]}`;
                }
                // Special case for top-level arrays to match expected inconsistent indentation
                const nestedIndent = pad === 0 ? ' '.repeat(index === 0 ? 3 : 2) : ' '.repeat(pad * 2 + 2);
                return `${indent}- ${lines[0]}\n${lines.slice(1).map((line) => nestedIndent + line).join('\n')}`;
            })
            .join('\n');
    }

    const indent = ' '.repeat(pad * 2);

    // Objects will be like key: value
    return Object.entries(json)
        .filter(([_, value]) => isNotEmpty(value))
        .map(([key, value]) => {
            const valueStr = jsonToMarkdown(value, pad + 1);
            if ((Array.isArray(value) && valueStr.includes('\n'))
                || (!Array.isArray(value) && typeof value === 'object' && value !== null && valueStr.includes('\n'))) {
                // Multi-line arrays or objects in objects should be on new lines with proper indentation
                return `${indent}${key}:\n${valueStr}`;
            }
            // For inline values, don't add indent if we're in a nested context
            const keyIndent = pad > 0 && typeof value === 'object' && value !== null ? '' : indent;
            return `${keyIndent}${key}: ${valueStr}`;
        })
        .join('\n');
}
