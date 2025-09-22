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

function typeOfJson(json: JSON): 'string' | 'number' | 'boolean' | 'object' | 'array-simple' | 'array-object' | 'array-mixed' | 'null' {
    if (Array.isArray(json)) {
        if (json.every((item) => typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean' || item === null)) {
            return 'array-simple';
        }
        if (json.every((item) => typeof item === 'object' && item !== null && !Array.isArray(item))) {
            return 'array-object';
        }
        return 'array-mixed';
    }
    if (json === null) {
        return 'null';
    }
    return typeof json as 'string' | 'number' | 'boolean' | 'object' | 'null';
}

function isOneLiner(json: JSON): boolean {
    const type = typeOfJson(json);
    return type === 'string' || type === 'number' || type === 'boolean' || type === 'array-simple';
}

function getIndent(pad: number, withBullet: boolean): string {
    return ' '.repeat((pad + 1 - (withBullet ? 1 : 0)) * 2) + (withBullet ? '- ' : '');
}

export function jsonToMarkdown(json: Readonly<JSON>): string {
    const cloned = structuredClone(json) as JSON; // Copy data to avoid mutating the original object
    const simplified = simplifyJson(cloned);
    // TODO: clear null values
    return serializeJsonTopLevel(simplified);
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

function serializeJsonTopLevel(json: JSON): string {
    switch (typeOfJson(json)) {
        case 'string':
        case 'number':
        case 'boolean':
            return String(json);
        case 'null':
            return '';
        case 'object':
            return serializeJson(json, 0);
        case 'array-simple':
        case 'array-mixed':
            return serializeJson(json, 0);
        case 'array-object':
            return (json as JSON[]).map((unknownItem, index) => {
                const item = unknownItem as Record<string, object>;
                let title;
                if (item.title) {
                    title = `${index + 1}. ${item.title}`;
                    delete item.title;
                } else if (item.name) {
                    title = `${index + 1}. ${item.name}`;
                    delete item.name;
                } else {
                    title = `${index + 1}. Item`;
                }

                let result = '';
                result += `## ${title}\n`;
                result += serializeJson(unknownItem, 0);
                return result;
            }).join('\n\n');
        default:
            return serializeJson(json, 0);
    }
}

function serializeJson(json: JSON, pad: number): string {
    switch (typeOfJson(json)) {
        case 'string':
        case 'number':
        case 'boolean':
            return pad === 0 ? getIndent(pad, true) + String(json) : String(json);
        case 'object':
            return Object.entries(json as Record<string, JSON>)
                .filter(([key, value]) => !isEmpty(value))
                .map(([key, value], index) => {
                    const indentLevel = pad;
                    const prefix = `${getIndent(indentLevel, true)}${key}:`;
                    if (isOneLiner(value)) {
                        return `${prefix} ${serializeJson(value, -1)}`;
                    }
                    return `${prefix}\n${serializeJson(value, pad + 1)}`;
                })
                .join('\n');
        case 'array-simple':
            return `${(json as JSON[]).filter(isNotEmpty).join(', ')}`;
        case 'array-mixed':
            return (json as JSON[]).filter(isNotEmpty).map((unknownItem) => {
                const itemType = typeOfJson(unknownItem);
                if (itemType === 'array-simple' || itemType === 'array-object') {
                    return `- ${serializeJson(unknownItem, -1)}`;
                }
                if (itemType === 'object') {
                    return Object.entries(unknownItem as Record<string, JSON>)
                        .filter(([key, value]) => !isEmpty(value))
                        .map(([key, value], index) => {
                            const prefix = `${getIndent(pad, index === 0)}${key}:`;
                            if (isOneLiner(value)) {
                                return `${prefix} ${serializeJson(value, -1)}`;
                            }
                            return `${prefix}\n${serializeJson(value, pad + 1)}`;
                        })
                        .join('\n');
                }
                return serializeJson(unknownItem, pad);
            }).join('\n');
        case 'array-object':
            return (json as JSON[]).filter(isNotEmpty).map((unknownItem) => {
                return Object.entries(unknownItem as Record<string, JSON>)
                    .filter(([key, value]) => !isEmpty(value))
                    .map(([key, value], index) => {
                        const indentLevel = pad === 1 ? 1 : pad;
                        const withBullet = pad === 1 ? index === 0 : true;
                        return `${getIndent(indentLevel, withBullet)}${key}: ${serializeJson(value, -1)}`;
                    }).join('\n');
            }).join('\n');
        case 'null':
            return '';
        default:
            throw new Error(`Unknown type: ${typeof json}`);
    }
}
