import type { ActorDefinitionStorage } from '../types.js';

/**
 * Returns an array of all field names mentioned in the display.properties
 * of all views in the given ActorDefinitionStorage object.
 */
export function getActorDefinitionStorageFieldNames(storage: ActorDefinitionStorage | object): string[] {
    const fieldSet = new Set<string>();
    if ('views' in storage && typeof storage.views === 'object' && storage.views !== null) {
        for (const view of Object.values(storage.views)) {
            // Collect from display.properties
            if (view.display && view.display.properties) {
                Object.keys(view.display.properties).forEach((field) => fieldSet.add(field));
            }
            // Collect from transformation.fields
            if (view.transformation && Array.isArray(view.transformation.fields)) {
                view.transformation.fields.forEach((field) => {
                    if (typeof field === 'string') fieldSet.add(field);
                });
            }
        }
    }
    return Array.from(fieldSet);
}
