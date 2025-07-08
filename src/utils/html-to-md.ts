import TurndownService from 'turndown';

const turndown = new TurndownService();

// Remove non-visible elements
turndown.remove('script');
turndown.remove('style');
turndown.remove('noscript');

// Remove multimedia elements
turndown.remove('svg');
turndown.remove('img');
turndown.remove('figure');
turndown.remove('video');
turndown.remove('audio');
turndown.remove('picture');

// Remove interactive elements
turndown.remove('canvas');
turndown.remove('button');
turndown.remove('select');
turndown.remove('input');

// Remove embedded
turndown.remove('iframe');
turndown.remove('embed');
turndown.remove('object');

// Remove navigation and footer elements
turndown.remove('aside');
turndown.remove('nav');
turndown.remove('footer');

/**
 * Converts HTML content to Markdown format using Turndown.
 */
export function htmlToMarkdown(html: string): string {
    return turndown.turndown(html);
}
