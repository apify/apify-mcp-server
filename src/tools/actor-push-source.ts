/**
 * PLACEHOLDER — actor-push-source MCP tool
 *
 * Intent: MCP-side analogue of `apify push` — accept an Actor's source tree
 * (an already-scaffolded, already-built local project) via MCP and upload it
 * as a new version on the Apify platform. This is the missing "upload" surface
 * for MCP-only agentic clients.
 *
 * NOT YET IMPLEMENTED. This file is a bookmark so the work doesn't get lost.
 *
 * Scaffolding (creating a fresh Actor from a template) is deliberately NOT
 * this tool's job — that's a client-side concern served by the public
 * `apify/actor-templates` repo (manifest.json + raw file URLs). See the
 * closed issue `apify/apify-mcp-server#1037` for the discussion that
 * concluded MCP is not a scaffolder — it's an upload surface, analogous to
 * `apify push`.
 *
 * Blocked on:
 *   `apify/apify-core#29044` — the REST deploy contract decision. Whichever
 *   direction the platform team picks (docs get fixed to match the working
 *   JSON `sourceFiles` endpoint, OR the endpoint grows the documented
 *   tarball path), this tool wraps that contract. Shipping now would either
 *   bake in a broken path or a undocumented-and-could-change path.
 *
 * Related eval-side findings:
 *   - F21 (agentic-actor-dev-eval): "Hosted MCP has no local-source deploy
 *     primitive" — surfaced when the mcp-only stack in the eval consistently
 *     failed T2 (push) because there's no MCP tool that does what `apify push`
 *     does. Documented in
 *     `apify/agentic-actor-dev-eval` FINDINGS.md.
 *   - F38 (same repo): originally proposed as "template scaffolding via MCP"
 *     but reframed after discussion — MCP should mirror `apify push` (upload
 *     an already-built Actor), NOT scaffold from templates. That's a
 *     client-side (or CLI-side) concern. F38 rolls up into F21 as the same
 *     upload-surface story.
 *
 * Rough shape when it lands (subject to F29044 resolution):
 *
 *   // Zod input schema:
 *   //   {
 *   //     actorName: z.string(),       // <username>/<actor-name>
 *   //     versionNumber: z.string()     // MAJOR.MINOR (see also apify-cli#1245)
 *   //       .regex(/^([0-9]|[1-9][0-9])\.([0-9]|[1-9][0-9])$/),
 *   //     sourceFiles: z.array(z.object({
 *   //       name: z.string(),           // relative POSIX path
 *   //       format: z.enum(['TEXT', 'BASE64']),
 *   //       content: z.string(),
 *   //     })).min(1),
 *   //     overwrite: z.boolean().optional().default(false),
 *   //     buildTag: z.string().optional().default('latest'),
 *   //   }
 *   //
 *   // Behavior:
 *   //   1. Look up actorId by actorName via `GET /v2/acts/{name}`
 *   //   2. Call `PUT /v2/acts/{id}/versions/{ver}` (or the tarball variant,
 *   //      whichever wins in F29044) with the sourceFiles array
 *   //   3. Trigger a build if `buildTag` is provided (`POST /v2/acts/{id}/builds?tag=...`)
 *   //   4. Return { actorId, versionNumber, buildId?, buildStatus? }
 *   //
 *   // Auth: uses the MCP session's Apify token (same as every other tool
 *   // here). Fails clearly if the token doesn't have write scope on the
 *   // target account.
 *
 * DO NOT wire this into the tool registry (`src/const.ts` HelperTools enum
 * + `src/default/tools.ts`) until F29044 resolves. Reviewers of this
 * placeholder can ping the F29044 issue for status.
 */

// Intentionally no exports until F29044 unblocks the implementation.
export {};
