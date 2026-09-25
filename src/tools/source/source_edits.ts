import { splitLines } from './source_files.js';

/** A half-open range of character offsets, `[start, end)`, in the text as it stands now. */
export type TextRange = { start: number; end: number };

export type TextEdit = { oldText: string; newText: string; allOccurrences?: boolean };

/**
 * An edit that could not be applied, with the text the caller needs to fix its oldText. `hasContext` is false when
 * the detail shows none of the current text, so the caller has to read the file again to correct the edit.
 */
export type EditFailure = {
    reason: 'NO_MATCH' | 'MULTIPLE_MATCHES';
    editIndex: number;
    detail: string;
    hasContext: boolean;
};

export type EditsResult = { text: string; changedRanges: TextRange[] } | { failure: EditFailure };

/** A changed region with its context lines, returned so the caller need not read the file again. */
export type TextExcerpt = { path: string; startLine: number; endLine: number; text: string };

const NO_MATCH_EXCERPT_LINES = 10;
const MULTIPLE_MATCH_LINES_LISTED = 10;

/** The NO_MATCH context stays within the same budget as the excerpts of a successful edit. */
const MAX_NO_MATCH_CONTEXT_BYTES = 4 * 1024;

/**
 * Of a line too long to show whole (minified code, one-line JSON), this many characters around the match are shown;
 * at most 3 UTF-8 bytes per character, they stay within `MAX_NO_MATCH_CONTEXT_BYTES`.
 */
const LONG_LINE_WINDOW_CHARS = 1024;
const LONG_LINE_CHARS_BEFORE_MATCH = 256;

/** Start offsets of the non-overlapping occurrences of `needle`, left to right. */
function findOccurrences(text: string, needle: string): number[] {
    const offsets: number[] = [];
    let from = 0;
    for (;;) {
        const offset = text.indexOf(needle, from);
        if (offset === -1) return offsets;
        offsets.push(offset);
        from = offset + needle.length;
    }
}

/** Every line break is CRLF; a file with mixed line endings gets no conversion. */
function hasOnlyCrlfLineBreaks(text: string): boolean {
    return text.includes('\r\n') && !/(?<!\r)\n/.test(text);
}

function convertToCrlf(text: string): string {
    return text.replace(/(?<!\r)\n/g, '\r\n');
}

/** The 1-based line of a character offset. */
function getLineNumber(text: string, offset: number): number {
    let line = 1;
    for (let index = text.indexOf('\n'); index !== -1 && index < offset; index = text.indexOf('\n', index + 1)) line++;
    return line;
}

/**
 * The offset where `oldText` matches when whitespace is ignored, or where its first non-blank line does when that
 * line occurs once (a common line such as `}` would point anywhere); undefined otherwise. Gives the caller the current
 * text to copy a corrected oldText from.
 */
function findClosestMatchOffset(text: string, oldText: string): number | undefined {
    const compactChars: string[] = [];
    const offsets: number[] = [];
    for (let index = 0; index < text.length; index++) {
        if (/\s/.test(text[index])) continue;
        compactChars.push(text[index]);
        offsets.push(index);
    }
    const compactText = compactChars.join('');
    const compactOldText = oldText.replace(/\s+/g, '');
    if (compactOldText === '') return undefined;
    const wholeIndex = compactText.indexOf(compactOldText);
    if (wholeIndex !== -1) return offsets[wholeIndex];
    const firstLine = oldText
        .split('\n')
        .map((line) => line.replace(/\s+/g, ''))
        .find((line) => line !== '');
    if (!firstLine) return undefined;
    const lineIndex = compactText.indexOf(firstLine);
    return lineIndex !== -1 && lineIndex === compactText.lastIndexOf(firstLine) ? offsets[lineIndex] : undefined;
}

/**
 * The current text around `offset`: up to `NO_MATCH_EXCERPT_LINES` lines from 2 before its line, cut from the end
 * (then the start) to fit `MAX_NO_MATCH_CONTEXT_BYTES`; for a line too long on its own, a window of it.
 */
function formatCurrentTextAround(text: string, offset: number): string {
    const lines = splitLines(text);
    const matchLine = getLineNumber(text, offset);
    const getLineBytes = (line: number) => Buffer.byteLength(lines[line - 1], 'utf8');
    if (getLineBytes(matchLine) > MAX_NO_MATCH_CONTEXT_BYTES) {
        const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
        const lineEnd = lineStart + lines[matchLine - 1].length;
        const start = Math.max(lineStart, offset - LONG_LINE_CHARS_BEFORE_MATCH);
        const end = Math.min(lineEnd, start + LONG_LINE_WINDOW_CHARS);
        return (
            `Line ${matchLine} is too long to show whole; its characters ${start - lineStart + 1} to ` +
            `${end - lineStart}:\n${text.slice(start, end)}`
        );
    }
    let startLine = Math.max(1, Math.min(matchLine - 2, lines.length - NO_MATCH_EXCERPT_LINES + 1));
    let endLine = Math.min(lines.length, startLine + NO_MATCH_EXCERPT_LINES - 1);
    let totalBytes = 0;
    for (let line = startLine; line <= endLine; line++) totalBytes += getLineBytes(line);
    // The match line alone fits, so this stops at it at the latest.
    while (totalBytes > MAX_NO_MATCH_CONTEXT_BYTES) {
        if (endLine > matchLine) {
            totalBytes -= getLineBytes(endLine);
            endLine--;
        } else {
            totalBytes -= getLineBytes(startLine);
            startLine++;
        }
    }
    return `The current text of lines ${startLine}-${endLine}:\n${lines.slice(startLine - 1, endLine).join('')}`;
}

function formatNoMatchDetail(
    text: string,
    edit: TextEdit,
    editIndex: number,
): Pick<EditFailure, 'detail' | 'hasContext'> {
    const newTextOffsets = edit.newText === '' ? [] : findOccurrences(text, edit.newText);
    const isMaybeApplied = newTextOffsets.length === 1;
    const offset = findClosestMatchOffset(text, edit.oldText);
    if (offset !== undefined) {
        const appliedNote = isMaybeApplied ? ' newText is in the file once, so this edit may already be applied.' : '';
        return {
            detail:
                `oldText of edits[${editIndex}] is not in the file byte for byte; the closest match ignoring ` +
                `whitespace is at line ${getLineNumber(text, offset)}.${appliedNote} ${formatCurrentTextAround(text, offset)}`,
            hasContext: true,
        };
    }
    if (isMaybeApplied) {
        const [newTextOffset] = newTextOffsets;
        return {
            detail:
                `oldText of edits[${editIndex}] is not in the file, even ignoring whitespace, but newText is in it ` +
                `once, at line ${getLineNumber(text, newTextOffset)}, so this edit may already be applied. ` +
                formatCurrentTextAround(text, newTextOffset),
            hasContext: true,
        };
    }
    return {
        detail: `oldText of edits[${editIndex}] is not in the file, and it has no whitespace-insensitive match either.`,
        hasContext: false,
    };
}

function formatMultipleMatchesDetail(text: string, offsets: readonly number[], editIndex: number): string {
    const lineNumbers = offsets.slice(0, MULTIPLE_MATCH_LINES_LISTED).map((offset) => getLineNumber(text, offset));
    const more = offsets.length > MULTIPLE_MATCH_LINES_LISTED ? ', and more' : '';
    return (
        `oldText of edits[${editIndex}] matches ${offsets.length} times, at lines ${lineNumbers.join(', ')}${more}. ` +
        'Add surrounding lines to oldText so it matches once, or set allOccurrences to replace every match.'
    );
}

/**
 * Moves ranges of the text before a replacement to where they are after it. A range that overlaps a replaced
 * occurrence grows to cover its replacement.
 */
function shiftRanges(params: {
    ranges: readonly TextRange[];
    offsets: readonly number[];
    oldLength: number;
    newLength: number;
}): TextRange[] {
    const { ranges, offsets, oldLength, newLength } = params;
    const delta = newLength - oldLength;
    // A start inside a replaced occurrence moves to where its replacement starts, an end to where it ends.
    const mapStart = (offset: number): number => {
        for (const [index, occurrence] of offsets.entries()) {
            if (offset < occurrence) return offset + index * delta;
            if (offset < occurrence + oldLength) return occurrence + index * delta;
        }
        return offset + offsets.length * delta;
    };
    const mapEnd = (offset: number): number => {
        for (const [index, occurrence] of offsets.entries()) {
            if (offset <= occurrence) return offset + index * delta;
            if (offset <= occurrence + oldLength) return occurrence + index * delta + newLength;
        }
        return offset + offsets.length * delta;
    };
    return ranges.map(({ start, end }) => ({ start: mapStart(start), end: Math.max(mapStart(start), mapEnd(end)) }));
}

/**
 * Applies the edits in order, each to the text the previous ones left. Each oldText must match exactly once, or at
 * least once with allOccurrences, byte for byte. The one exception: in a file with only CRLF line breaks, an LF
 * oldText that misses is retried with oldText and newText converted to CRLF, since models write LF.
 * `changedRanges` starts from ranges earlier operations changed and comes back with this call's added.
 */
export function applyTextEdits(
    originalText: string,
    edits: readonly TextEdit[],
    changedRanges: readonly TextRange[] = [],
): EditsResult {
    let text = originalText;
    let ranges = [...changedRanges];
    for (const [editIndex, edit] of edits.entries()) {
        let { oldText, newText } = edit;
        let offsets = findOccurrences(text, oldText);
        if (offsets.length === 0 && oldText.includes('\n') && !oldText.includes('\r') && hasOnlyCrlfLineBreaks(text)) {
            const crlfOffsets = findOccurrences(text, convertToCrlf(oldText));
            if (crlfOffsets.length > 0) {
                offsets = crlfOffsets;
                oldText = convertToCrlf(oldText);
                newText = convertToCrlf(newText);
            }
        }
        if (offsets.length === 0) {
            return { failure: { reason: 'NO_MATCH', editIndex, ...formatNoMatchDetail(text, edit, editIndex) } };
        }
        if (offsets.length > 1 && !edit.allOccurrences) {
            const detail = formatMultipleMatchesDetail(text, offsets, editIndex);
            return { failure: { reason: 'MULTIPLE_MATCHES', editIndex, detail, hasContext: true } };
        }
        const pieces: string[] = [];
        let from = 0;
        for (const offset of offsets) {
            pieces.push(text.slice(from, offset), newText);
            from = offset + oldText.length;
        }
        pieces.push(text.slice(from));
        ranges = shiftRanges({ ranges, offsets, oldLength: oldText.length, newLength: newText.length });
        const delta = newText.length - oldText.length;
        for (const [index, offset] of offsets.entries()) {
            const start = offset + index * delta;
            ranges.push({ start, end: start + newText.length });
        }
        text = pieces.join('');
    }
    return { text, changedRanges: ranges };
}

/**
 * The changed regions as line ranges with `contextLines` around them, overlapping ones merged, in file order.
 * An empty range, left by a deletion, shows the lines around the point where the text was.
 */
export function buildTextExcerpts(params: {
    path: string;
    text: string;
    ranges: readonly TextRange[];
    contextLines: number;
}): TextExcerpt[] {
    const { path, text, ranges, contextLines } = params;
    const lines = splitLines(text);
    if (lines.length === 0 || ranges.length === 0) return [];
    const lineRanges = ranges
        .map(({ start, end }) => {
            const firstLine = getLineNumber(text, start);
            const lastLine = end > start ? getLineNumber(text, end - 1) : firstLine;
            return {
                startLine: Math.max(1, Math.min(firstLine, lines.length) - contextLines),
                endLine: Math.min(lines.length, lastLine + contextLines),
            };
        })
        .sort((a, b) => a.startLine - b.startLine);
    const merged: { startLine: number; endLine: number }[] = [];
    for (const range of lineRanges) {
        const last = merged.at(-1);
        if (last && range.startLine <= last.endLine + 1) {
            last.endLine = Math.max(last.endLine, range.endLine);
            continue;
        }
        merged.push({ ...range });
    }
    return merged.map(({ startLine, endLine }) => ({
        path,
        startLine,
        endLine,
        text: lines.slice(startLine - 1, endLine).join(''),
    }));
}

/**
 * The excerpts in order while they fit in `maxBytes`; the first one that does not fit keeps the lines that do, and
 * the rest are left out. `isTruncated` tells the caller some changed lines are not shown.
 */
export function limitTextExcerpts(
    excerpts: readonly TextExcerpt[],
    maxBytes: number,
): { excerpts: TextExcerpt[]; isTruncated: boolean } {
    const kept: TextExcerpt[] = [];
    let remainingBytes = maxBytes;
    for (const excerpt of excerpts) {
        const excerptBytes = Buffer.byteLength(excerpt.text, 'utf8');
        if (excerptBytes <= remainingBytes) {
            kept.push(excerpt);
            remainingBytes -= excerptBytes;
            continue;
        }
        const fittingLines: string[] = [];
        for (const line of splitLines(excerpt.text)) {
            const lineBytes = Buffer.byteLength(line, 'utf8');
            if (lineBytes > remainingBytes) break;
            fittingLines.push(line);
            remainingBytes -= lineBytes;
        }
        if (fittingLines.length > 0) {
            const endLine = excerpt.startLine + fittingLines.length - 1;
            kept.push({ ...excerpt, endLine, text: fittingLines.join('') });
        }
        return { excerpts: kept, isTruncated: true };
    }
    return { excerpts: kept, isTruncated: false };
}
