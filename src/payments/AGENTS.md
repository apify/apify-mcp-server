<!-- agents-scope: src/payments -->
# src/payments — agentic payment providers (Skyfire, x402)

↑ [src/](../AGENTS.md) · sideways: [`../mcp/AGENTS.md`](../mcp/AGENTS.md)

The cross-file invariant no single file shows you:

> Payment data arrives in a **different place per provider** — Skyfire in the
> tool-call arguments (`skyfire-pay-id`), x402 in the JSON-RPC `_meta` under
> `x402/payment` — yet **both must be stripped before AJV validation and redacted
> before logging**, and the `?payment=` query selects which provider runs. Get any
> half wrong and you leak a credential into logs, fail validation on a field the
> tool's schema never declared, or charge through the wrong protocol.

## Files

- `index.ts` — public surface: `SkyfirePaymentProvider`, `X402PaymentProvider`,
  `resolvePaymentProvider`, `prepareToolCallContext`, and the shared types.
- `resolve.ts` — `resolvePaymentProvider(?payment=)` → `skyfire | x402`. Async: the
  x402 branch fetches payment requirements from the Apify API.
- `skyfire.ts` — injects `skyfire-pay-id` (a JWT starting `ey…`) into the schemas of
  tools with `paymentRequired: true`; forwards it as a header.
- `x402.ts` — reads payment from the JSON-RPC `_meta` key `x402/payment`; HTTP 402
  flow; forwards the `PAYMENT-SIGNATURE` header.
- `const.ts` — `PAYMENT_PROTOCOL_HEADER` and the Skyfire instruction strings (x402's live in `x402.ts`).
- `helpers.ts` — `prepareToolCallContext`: the choke point that strips payment fields
  before AJV, redacts them for logging, and builds the client.

## Rules when editing here

- **Every payment field passes through `prepareToolCallContext`** before validation
  and logging. Don't read a payment field anywhere downstream of it — by design it's
  already gone.
- **Make a tool pay-eligible by setting `paymentRequired: true` on its definition**, not by
  hand-injecting the schema field elsewhere — both `skyfire.ts` and `x402.ts` gate on that
  flag. `SKYFIRE_ENABLED_TOOLS` (`const.ts`) is the expected-list the Skyfire integration test
  asserts against; keep it in sync with the `paymentRequired` tools or that test fails.
- `skyfire-pay-id` is injected only at the top level, so `redactSkyfirePayId` redacts top-level only; if you ever nest a payment field, make the redactor recursive or it leaks.

## Local commands

```bash
pnpm run type-check
pnpm run test:unit
```

After any change here run the root [Verification](../../AGENTS.md) steps.

## See also

- [`../mcp/AGENTS.md`](../mcp/AGENTS.md) — the protocol surface that invokes payment context.
