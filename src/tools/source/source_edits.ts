/** A half-open range of character offsets, `[start, end)`, in the text as it stands now. */
export type TextRange = { start: number; end: number };

export type TextEdit = { oldText: string; newText: string; allOccurrences?: boolean };

/** An edit that could not be applied, with the text the caller needs to fix its oldText. */
export type EditFailure = { reason: 'NO_MATCH' | 'MULTIPLE_MATCHES'; editIndex: number; detail: string };

export type EditsResult = { text: string; changedRanges: TextRange[] } | { failure: EditFailure };

/** A changed region with its context lines, returned so the caller need not read the file again. */
export type TextExcerpt = { path: string; startLine: number; endLine: number; text: string };

const NO_MATCH_EXCERPT_LINES = 10;
const MULTIPLE_MATCH_LINES_LISTED = 10;

/** Lines with their line endings kept, so joined back they give the exact text. */
function splitLines(text: string): string[] {
    if (text === '') return [];
    return text.split(/(?<=\n)/);
}

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
 * The offset where `oldText` matches when whitespace is ignored, or where its first non-blank line does; undefined
 * when neither is in the text. Gives the caller the current text to copy a corrected oldText from.
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
    const firstLine = oldText
        .split('\n')
        .map((line) => line.replace(/\s+/g, ''))
        .find((line) => line !== '');
    for (const needle of [oldText.replace(/\s+/g, ''), firstLine]) {
        if (!needle) continue;
        const compactIndex = compactText.indexOf(needle);
        if (compactIndex !== -1) return offsets[compactIndex];
    }
    return undefined;
}

function formatNoMatchDetail(text: string, edit: TextEdit, editIndex: number): string {
    const appliedNote =
        edit.newText !== '' && findOccurrences(text, edit.newText).length === 1
            ? ' newText is in the file once, so this edit may already be applied.'
            : '';
    const offset = findClosestMatchOffset(text, edit.oldText);
    if (offset === undefined) {
        return `oldText of edits[${editIndex}] is not in the file, and nothing similar is.${appliedNote}`;
    }
    const lines = splitLines(text);
    const matchLine = getLineNumber(text, offset);
    const startLine = Math.max(1, Math.min(matchLine - 2, lines.length - NO_MATCH_EXCERPT_LINES + 1));
    const excerptLines = lines.slice(startLine - 1, startLine - 1 + NO_MATCH_EXCERPT_LINES);
    const endLine = startLine + excerptLines.length - 1;
    return (
        `oldText of edits[${editIndex}] is not in the file byte for byte; the closest match ignoring whitespace ` +
        `is at line ${matchLine}.${appliedNote} The current text of lines ${startLine}-${endLine}:\n${excerptLines.join('')}`
    );
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
function shiftRanges(
    ranges: readonly TextRange[],
    offsets: readonly number[],
    oldLength: number,
    newLength: number,
): TextRange[] {
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
            return { failure: { reason: 'NO_MATCH', editIndex, detail: formatNoMatchDetail(text, edit, editIndex) } };
        }
        if (offsets.length > 1 && !edit.allOccurrences) {
            const detail = formatMultipleMatchesDetail(text, offsets, editIndex);
            return { failure: { reason: 'MULTIPLE_MATCHES', editIndex, detail } };
        }
        const pieces: string[] = [];
        let from = 0;
        for (const offset of offsets) {
            pieces.push(text.slice(from, offset), newText);
            from = offset + oldText.length;
        }
        pieces.push(text.slice(from));
        ranges = shiftRanges(ranges, offsets, oldText.length, newText.length);
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
export function buildTextExcerpts(
    path: string,
    text: string,
    ranges: readonly TextRange[],
    contextLines: number,
): TextExcerpt[] {
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
