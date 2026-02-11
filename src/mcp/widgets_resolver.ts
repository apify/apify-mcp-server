import log from '@apify/log';

import type { AvailableWidget } from '../resources/widgets.js';
import { resolveAvailableWidgets } from '../resources/widgets.js';

/**
 * Resolves widgets and determines which ones are ready to be served.
 */
export async function resolveWidgets(uiMode?: 'openai'): Promise<Map<string, AvailableWidget> | undefined> {
    if (uiMode !== 'openai') {
        return undefined;
    }

    try {
        const { fileURLToPath } = await import('node:url');
        const path = await import('node:path');

        const filename = fileURLToPath(import.meta.url);
        const dirName = path.dirname(filename);

        const resolved = await resolveAvailableWidgets(dirName);

        const readyWidgets: string[] = [];
        const missingWidgets: string[] = [];

        for (const [uri, widget] of resolved.entries()) {
            if (widget.exists) {
                readyWidgets.push(widget.name);
            } else {
                missingWidgets.push(widget.name);
                log.softFail(`Widget file not found: ${widget.jsPath} (widget: ${uri})`);
            }
        }

        if (readyWidgets.length > 0) {
            log.debug('Ready widgets', { widgets: readyWidgets });
        }

        if (missingWidgets.length > 0) {
            log.softFail('Some widgets are not ready', {
                widgets: missingWidgets,
                note: 'These widgets will not be available. Ensure web/dist files are built and included in deployment.',
            });
        }

        return resolved;
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log.softFail(`Failed to resolve widgets: ${errorMessage}`);
        // Continue without widgets
        return undefined;
    }
}
