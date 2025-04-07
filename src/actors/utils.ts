export function actorNameToToolName(actorName: string): string {
    return actorName
        .replace(/\//g, '-slash-')
        .replace(/\./g, '-dot-')
        .slice(0, 64);
}
