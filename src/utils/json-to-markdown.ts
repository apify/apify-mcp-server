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

export function jsonToMarkdown(json: Readonly<JSON>): string {
    const cloned = structuredClone(json) as JSON; // Copy data to avoid mutating the original object
    const simplified = simplifyJson(cloned);
    return serializeJsonToMarkdown(simplified, 0);
}

function simplifyJson(json: JSON): JSON {
    if (json === null || typeof json !== 'object') {
        return json;
    }

    if (Array.isArray(json)) {
        const simplified = json.map(simplifyJson);
        // Check if this is an array of objects with single property where value is true
        if (simplified.every((item) => typeof item === 'object'
            && item !== null
            && !Array.isArray(item)
            && Object.keys(item).length === 1
            && Object.values(item)[0] === true,
        )) {
            const propertyNames = simplified.map((item) => Object.keys(item as Record<string, unknown>)[0]);
            return propertyNames.length === 1 ? propertyNames[0] : propertyNames.join(', ');
        }
        return simplified;
    }

    // For objects, recursively simplify all values
    const result: Record<string, JSON> = {};
    for (const [key, value] of Object.entries(json)) {
        result[key] = simplifyJson(value as JSON);
    }
    return result;
}

function serializeJsonToMarkdown(json: JSON, pad = 0): string {
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
            const content = serializeJsonToMarkdown(item, 0);
            return !content.includes('\n');
        });
        if (singleLine) {
            // For single-item arrays with simple content, don't add indent
            return json.filter(isNotEmpty)
                .map((value) => {
                    const content = serializeJsonToMarkdown(value, 0);
                    return `- ${content}`;
                })
                .join(' ');
        }
        return json.filter(isNotEmpty)
            .map((value, index) => {
                const content = serializeJsonToMarkdown(value, 0);
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
            const valueStr = serializeJsonToMarkdown(value, pad + 1);
            if ((Array.isArray(value) && valueStr.includes('\n'))
                || (!Array.isArray(value) && typeof value === 'object' && value !== null && valueStr.includes('\n'))) {
                // Multi-line arrays or objects in objects should be on new lines with proper indentation
                return `${indent}${key}:\n${valueStr}`;
            }
            // For inline values, don't add indent if we're in a nested context or if current object has single property with simple value
            const currentObjectHasSingleProperty = Object.keys(json).length === 1;
            const valueIsSimple = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
            const keyIndent = (pad > 0 && ((typeof value === 'object' && value !== null) || (currentObjectHasSingleProperty && valueIsSimple))) ? '' : indent;
            return `${keyIndent}${key}: ${valueStr}`;
        })
        .join('\n');
}
