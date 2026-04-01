const [major] = process.versions.node.split('.').map(Number);
if (major < 20) {
    process.stderr.write(
        `\nError: Node.js v${process.versions.node} is not supported.\n`
        + `Apify MCP server requires Node.js v20 or higher.\n`
        + `Please update Node.js from https://nodejs.org\n\n`,
    );
    process.exit(1);
}
