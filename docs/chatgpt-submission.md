# ChatGPT submission candidate

This candidate exposes 29 operations through the existing root endpoint. It is
not deployed or approved for submission. The thirteen curated operations have
`review: null` and reject execution before starting a paid run.

## Contract and configuration

[`CHATGPT_SUBMISSION_URL`](../src/chatgpt_submission.ts) is the canonical URL:
`https://mcp.apify.com/?tools=<29 individually named selectors>&client=openai`.
Use the complete generated value, not the placeholder above or expandable tool
categories. `client=openai` is attribution, not an authorization boundary.

The selected operations are thirteen curated Actor tools, nine private Actor
source/build/run tools, run status/log/abort, dataset items, key-value records,
and two documentation tools. The four automatically added run/storage helpers
are already in that inventory. Both protocol adapters expose the same tool
names, schemas, and annotations. There is no dynamic tool registration, generic
API resource access, or implicit widget expansion in this configuration.

Web Search and Web Fetch are selected. RAG Web Browser is omitted. Existing
general defaults and the Anthropic configuration are unchanged. These aliases
are explicit-only tools, not a new category or a `/chatgpt` endpoint. Adding a
generic API read tool creates a different, broader configuration; it must not
be included in the submission URL.

## Curated release approval

[`curated_actor_catalog.ts`](../src/tools/actors/curated_actor_catalog.ts) defines
closed inputs and explicit mappings for the thirteen operations. No publisher
account is allowlisted. The immutable Actor IDs and candidate build IDs/numbers
are in [`curated_actor_releases.ts`](../src/tools/actors/curated_actor_releases.ts).
The pinned-schema fixture records the upstream input schema and its hash for
offline compatibility tests; compatibility does not establish correct runtime
behavior or permission to access a target service.

Before filling a release's review record, the maintainer must inspect the exact
build, dependencies, nested Actor/service calls, data handling, permissions,
and all input defaults; establish maintenance responsibility and permitted
downstream access; and test allowed and excluded inputs against that build.
Record the reviewer, time, contract version, and evidence reference in the
same release record. A new build or contract requires a new review. Do not
populate an approval merely to make a smoke test pass.

Each curated run verifies Actor/build identity and success, forces limited
permissions, and sets a $1 run charge limit, 300-second timeout, 4096 MiB memory
limit, and a maximum of 50 paid items. The paid-item limit is not a universal
row or request limit. Actor-specific page/result limits are set separately.
Retries can start another paid run.

Additional review points:

- Sitemap Extractor has no native result cap. Finite sitemap traversal depth,
  `checkPageStatus: false`, run limits, and paginated returned rows constrain
  different kinds of work; do not describe them as a hard upstream row cap.
- Website Content Crawler uses restricted crawling inputs and no supplied
  cookies or executable hooks. Test the selected mode at the 4096 MiB limit;
  its current upstream default requests more memory.
- URL checks reject obvious local/private addresses and unsupported domains.
  They do not establish protection against DNS changes or redirects. Verify
  actual network behavior with each maintainer, including Web Fetch's
  protection-bypass behavior.
- All thirteen operations need source/runtime and target-service review,
  including those whose Store pages say they are maintained by Apify.

## Private development and retrieval

The nine private tools reuse existing source/build handlers, with fresh
connected-account ownership and private-status checks. Only inline source
files are accepted for source editing. Source hash/revision checks remain in
place. Environment-variable arguments, copying versions, automatic builds,
publishing, webhooks, and permission overrides are excluded.

The runner requires an explicitly selected successful build, checks its Actor,
and starts its exact build number with forced limited permissions. Defaults
are 60 seconds, 1024 MiB, a $1 run charge cap, and 30 seconds waiting; maxima
are 300 seconds, 4096 MiB, $5, and 45 seconds. A returned Actor/build mismatch
requests an abort. Build operations can execute customer build code and incur
usage; the build API exposes no equivalent charge/duration cap.

Private code is programmable: it can use existing environment configuration,
access external services, and invoke other limited-permission Actors. A parent
run's cap does not cover independently started child runs. Ownership checks
are rechecked before writes but are not an atomic platform transaction.
Obtain written OpenAI clearance for this execution model.

Submitted retrieval allows at most 100 dataset rows per call (default 20) and
1–50 recent log lines (default 10). Serialized tool responses are limited to
256 KiB. Oversized responses are withheld with an error, not returned as
broken partial JSON. These checks happen after fetching and do not bound the
upstream download or memory allocation. Session tokens and recognized Apify
credentials are redacted from text and structured output; arbitrary secrets
in customer code or binary files cannot be exhaustively detected.

## Release sequence and evidence

1. Review and merge the server implementation and downstream packaging/sync
   changes. Deploy the new selectors, including Web Search, before validating
   the candidate endpoint. No deployment is performed by this patch.
2. Obtain written OpenAI guidance on private code and nested execution,
   the curated target services, existing-account metered credits/recharge,
   and a future marketplace expansion. Reconcile privacy, output rights,
   billing, and availability with legal.
3. Complete each pinned Actor's review and human-operated runtime tests with
   a dedicated account and agreed budget. Remove unresolved Actors from both
   the server selection and plugin manifest, and report the reduced scope.
4. Test OAuth connect/revoke, ownership/private failures, source conflicts,
   build failure, exact-build execution, cancellation, bounded output,
   credential redaction, session restoration, and absent operations on both
   supported protocol revisions. Repository integration tests are human-run.
5. Build the MCP-only ZIP from the plugin repository's explicit file allowlist.
   Compare its selectors with this module. Run the five positive and three
   negative portal cases and retain the full thirteen-Actor matrix.
6. Record a fresh demonstration of the exact package and endpoint in each
   advertised ChatGPT surface. Complete publisher, country, commerce, reviewer
   access, and legal attestations in the portal; then submit after clearance.

Local checks use mocked API responses and pinned public schemas. They do not
prove OAuth, deployed behavior, output quality, legal clearance, or approval.
