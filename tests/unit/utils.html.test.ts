import { describe, expect, it } from 'vitest';

import { stripHtml } from '../../src/utils/html.js';

describe('stripHtml', () => {
    it('should remove unwanted attributes and keep allowed ones', () => {
        const input = '<div class="test" id="myDiv" style="color:red" data-value="123" href="http://example.com">Content</div>';
        const expected = '<div class="test" id="myDiv" data-value="123">Content</div>';
        expect(stripHtml(input)).toBe(expected);
    });

    it('should remove all attributes except allowed ones', () => {
        const input = '<a href="http://example.com" onclick="alert()" title="Link" name="test">Link</a>';
        const expected = '<a href="http://example.com" title="Link" name="test">Link</a>';
        expect(stripHtml(input)).toBe(expected);
    });

    it('should keep data-* attributes', () => {
        const input = '<div data-toggle="modal" data-id="123" class="btn">Button</div>';
        const expected = '<div data-toggle="modal" data-id="123" class="btn">Button</div>';
        expect(stripHtml(input)).toBe(expected);
    });

    it('should remove style, script, and other unwanted tags', () => {
        const input = '<html><head><style>body { color: red; }</style></head><body><script>alert("test");</script><p>Content</p></body></html>';
        const expected = '<html><head></head><body><p>Content</p></body></html>';
        expect(stripHtml(input)).toBe(expected);
    });

    it('should remove noscript, iframe, svg, canvas, math tags', () => {
        const input = '<div><noscript>JS disabled</noscript><iframe src="http://example.com"></iframe><svg><circle></circle></svg><canvas></canvas><math></math><p>Text</p></div>';
        const expected = '<div><p>Text</p></div>';
        expect(stripHtml(input)).toBe(expected);
    });

    it('should remove HTML comments', () => {
        const input = '<div><!-- This is a comment --><p>Content</p></div>';
        const expected = '<div><p>Content</p></div>';
        expect(stripHtml(input)).toBe(expected);
    });

    it('should remove base64 encoded images', () => {
        const input = '<div><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==" '
            + 'alt="test"><p>Text</p></div>';
        const expected = '<div><p>Text</p></div>';
        expect(stripHtml(input)).toBe(expected);
    });

    it('should keep regular images with http src', () => {
        const input = '<img src="http://example.com/image.png" alt="Image" class="img">';
        const expected = '<img src="http://example.com/image.png" alt="Image" class="img">';
        expect(stripHtml(input)).toBe(expected);
    });

    it('should collapse multiple spaces and remove spaces between tags', () => {
        const input = '<div>  <p>   Text   </p>  </div>';
        const expected = '<div><p> Text </p></div>';
        expect(stripHtml(input)).toBe(expected);
    });

    it('should trim the result', () => {
        const input = '  <div>Content</div>  ';
        const expected = '<div>Content</div>';
        expect(stripHtml(input)).toBe(expected);
    });

    it('should handle empty string', () => {
        expect(stripHtml('')).toBe('');
    });

    it('should handle plain text', () => {
        const input = 'Just plain text';
        expect(stripHtml(input)).toBe('Just plain text');
    });

    it('should handle malformed HTML', () => {
        const input = '<div><p>Unclosed tag';
        const expected = '<div><p>Unclosed tag</p></div>';
        expect(stripHtml(input)).toBe(expected);
    });

    it('should handle nested elements with mixed attributes', () => {
        const input = '<div class="container" style="margin:0"><a href="http://test.com" onclick="return false" data-type="link">Link</a></div>';
        const expected = '<div class="container"><a href="http://test.com" data-type="link">Link</a></div>';
        expect(stripHtml(input)).toBe(expected);
    });
});
