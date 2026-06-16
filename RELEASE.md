# Releasing

There are two release tracks:

1. **The npm package `@apify/actors-mcp-server`** (this repo) — documented below.
2. **The hosted server at [mcp.apify.com](https://mcp.apify.com)** — lives in the hosted-server repo (`apify/apify-mcp-server-internal`); see its `RELEASE.md`. A package release here automatically opens a dependency-bump PR there, which starts that track.

Versioning is [SemVer](https://semver.org/). Conventional Commits drive automatic bumps (`feat:` → minor, `fix:` → patch, `!` → major).

## Release the npm package

Prerequisite: the changes you want to ship are merged to `master`.

1. **Actions → "Stable release" → Run workflow.** Pick the release type:
   - `auto` (default) — git-cliff derives the bump from the Conventional Commit history since the last tag.
   - `patch` / `minor` / `major` — force a specific bump.
   - `custom` — exact version supplied in `custom_version`.
2. The workflow (`.github/workflows/manual_release_stable.yaml`) then runs end-to-end with no further input:
   - Computes the version and updates `CHANGELOG.md`, `package.json`, `manifest.json`, and `server.json` (committed with `[skip ci]`).
   - Builds the MCPB bundle, validates the manifest, and smoke-tests it.
   - Creates the **GitHub release** with `apify-mcp-server.mcpb` attached.
   - Publishes to **npm** (`latest` tag) and smoke-tests the published tarball.
   - Publishes the version to the **MCP Registry**.
   - Opens a **dependency-bump PR** in `apify/apify-mcp-server-internal` (you are added as reviewer).

That completes the package release. To roll the new version out to `mcp.apify.com`, continue with the hosted-server repo: merge the bump PR, then run its release process.

## What gets published where

| Target | Artifact |
| --- | --- |
| GitHub release | `apify-mcp-server.mcpb` bundle + release notes |
| npm | `@apify/actors-mcp-server@<version>` (`latest`) |
| MCP Registry | the new server version |
| `apify-mcp-server-internal` | PR bumping `@apify/actors-mcp-server` |

## Notes

- The changelog commit carries `[skip ci]` so it does not retrigger CI.
- When you change a tool contract here, update the matching integration tests in the hosted-server repo in the same release window — drift there has broken hosted releases before.
