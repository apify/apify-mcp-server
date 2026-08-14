#!/usr/bin/env bash
#
# Packs the package and imports every subpath export from a consumer that has no
# monorepo context. Catches emitted specifiers that resolve inside the checkout but
# not inside a real install — e.g. `dist/test_kit/*.js` importing `../../src/*.js`,
# which only `files: ["dist"]` excludes.
#
# The consumer MUST live outside the repo: from a directory inside it, Node walks up
# and finds the repo's own node_modules, which masks exactly the failure this checks.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONSUMER="$(mktemp -d "${RUNNER_TEMP:-/tmp}/mcp-pack-check.XXXXXX")"
trap 'rm -rf "$CONSUMER"' EXIT

cd "$REPO_ROOT"
pnpm pack --pack-destination "$CONSUMER" >/dev/null
TARBALL="$(echo "$CONSUMER"/*.tgz)"
echo "packed: $(basename "$TARBALL")"

PKG_MANAGER="$(node -p 'require("./package.json").packageManager')"
# pnpm does not install optional peers, so a real consumer installs them by hand — mirror
# that. Read them from peerDependencies ONLY: anything the published code needs at runtime
# but declares merely as a devDependency must fail here, not in someone else's repo.
read -r -a PEERS <<<"$(node -p '
    Object.entries(require("./package.json").peerDependencies ?? {})
        .map(([name, range]) => `${name}@${range}`)
        .join(" ")
')"

cd "$CONSUMER"
cat > package.json <<EOF
{
    "name": "pack-check-consumer",
    "private": true,
    "type": "module",
    "version": "1.0.0",
    "packageManager": "$PKG_MANAGER"
}
EOF
# Flat layout, and never treat the repo above as a workspace root.
printf 'node-linker=hoisted\nignore-workspace=true\n' > .npmrc

echo "declared optional peers: ${PEERS[*]:-none}"
pnpm add "$TARBALL" "${PEERS[@]}" >/dev/null
echo "installed into a clean consumer: $CONSUMER"

if [[ -d node_modules/@apify/actors-mcp-server/src ]]; then
    echo "FAIL: installed package contains src/ — the check below would pass for the wrong reason." >&2
    exit 1
fi

node --input-type=module <<'EOF'
const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exit(1); };

// Plain `node`, no bundler and no TypeScript-aware resolver to paper over bad specifiers.
process.on('uncaughtException', (err) => {
    console.error(`FAIL: import threw ${err.code ?? err.name} — ${err.message}`);
    process.exit(1);
});

const main = await import('@apify/actors-mcp-server');
if (typeof main.ActorsMcpServer !== 'function') fail('. does not export ActorsMcpServer');

const internals = await import('@apify/actors-mcp-server/internals.js');
if (typeof internals.getDefaultTools !== 'function') fail('./internals does not export getDefaultTools');

const kit = await import('@apify/actors-mcp-server/test-kit');
if (typeof kit.registerCases !== 'function') fail('./test-kit does not export registerCases');
if (!Array.isArray(kit.allCases) || kit.allCases.length === 0) fail('./test-kit exports no cases');

// Every case must be whole: a partially-emitted build can still import cleanly.
const broken = kit.allCases.filter((c) => typeof c?.name !== 'string' || typeof c?.run !== 'function');
if (broken.length > 0) fail(`${broken.length} of ${kit.allCases.length} cases are malformed`);

console.log(`OK — . / internals / test-kit all load; ${kit.allCases.length} cases`);
EOF
