# x402 Proposal Review: Gaps Found via Coinbase Reference Implementation

Review of the [Agentic Payments - x402 Notion proposal](https://www.notion.so/apify/Agentic-Payments-x402-30af39950a22802699caeec9597fb3a5) against the official [Coinbase x402 SDK](https://github.com/coinbase/x402) (`@x402/mcp` package) and the [xMCP x402 plugin](https://github.com/basementstudio/xmcp/tree/main/packages/plugins/x402).

## Key Findings

1. **The proposal treats x402 as an HTTP concern, but the Coinbase reference implements it as an MCP protocol concern.** Both layers should be supported — HTTP for `mcpc`, MCP protocol (`_meta`) for standard x402 clients.

2. **Standard x402 MCP client/server patterns cannot be used as-is** because Apify's pricing model is fundamentally different (unknown cost, prepaid balance, async refund). The standard patterns are useful as a **protocol reference** but not as a drop-in implementation.

---

## Why standard x402 MCP patterns don't fit Apify

### The standard x402 MCP flow (Coinbase `createPaymentWrapper`)

```
verify → execute tool → settle (if success) → return result
```

Per-call. Price known upfront. One payment = one tool call. Done.

### Apify's flow

```
verify + settle $5 upfront → start Actor → Actor runs for minutes/hours →
→ daemon calculates actual cost ($1.50) → refund $3.50 on-chain (async)
```

These are incompatible for four reasons:

1. **Settlement timing** — Coinbase settles AFTER execution. Apify settles BEFORE (because the Actor hasn't finished yet, cost is unknown at MCP response time).

2. **Tool execution ≠ actual work** — calling `call-actor` in MCP returns immediately (Actor started). The real cost accumulates as the Actor runs, long after the MCP response is sent.

3. **Refund is async** — happens via `AGENTIC_PAYMENTS_SETTLING_DAEMON` minutes/hours later. There's no MCP response to attach it to. The standard `_meta["x402/payment-response"]` with `{ success, transaction }` doesn't cover this.

4. **One payment covers many tool calls** — `call-actor`, then `get-actor-run`, then `get-dataset-items` — all drawing from the same $5 balance. The standard pattern is 1 payment = 1 tool call.

### Can a standard `x402MCPClient` connect to Apify?

**Yes — more than initially expected.** The Coinbase [`x402MCPClient`](https://github.com/coinbase/x402/blob/main/examples/typescript/clients/mcp/simple.ts) can handle the payment flow if the Apify MCP server speaks the standard `_meta` protocol. Once a wallet is created and funded, any x402-aware MCP client can connect — `mcpc` is not the only option.

The standard client handles the initial flow out of the box (402 → create payment → retry). Payment caching and balance-aware reuse can be added via hooks:

```typescript
let cachedPayment: PaymentPayload | null = null;
let remainingBalance: number | null = null;

x402Mcp.onPaymentRequired(async () => {
  // Reuse cached payment if it still has balance
  if (cachedPayment && remainingBalance !== null && remainingBalance > 0) {
    return { payment: cachedPayment };
  }
  // Otherwise, let normal flow create a new payment
  cachedPayment = null;
  remainingBalance = null;
});

x402Mcp.onAfterPayment(async (ctx) => {
  cachedPayment = ctx.paymentPayload;
  // Read Apify-specific balance from _meta response
  const response = ctx.result?._meta?.["x402/payment-response"];
  if (response?.remainingBalanceUsd !== undefined) {
    remainingBalance = response.remainingBalanceUsd;
  }
});
```

**Key nuances:**
- Every unpaid call triggers a wasted 402 round-trip (call → 402 → retry with cached payment). That's 2x requests per tool call. `mcpc` avoids this by pre-attaching payment based on `tools/list` metadata.
- The `remainingBalanceUsd` field in `_meta["x402/payment-response"]` is Apify-specific. Standard x402 clients won't read it unless they add custom logic (as shown above). Without it, a client would blindly reuse an exhausted payment until the server rejects it.
- The refund for unused balance is handled entirely server-side by `AGENTIC_PAYMENTS_SETTLING_DAEMON` — no client involvement needed. The user's wallet receives unused funds automatically.

### Conclusion

**`mcpc` is an optimization, not a requirement.** A standard `x402MCPClient` with ~15 lines of hook code can handle Apify's prepaid balance model. `mcpc` adds value by:
- Avoiding the double round-trip (pre-attaching payment based on tool metadata)
- Built-in balance tracking without custom hook code
- Wallet creation CLI (`mcpc x402 init`)

But for AI frameworks and third-party clients that already implement `@x402/mcp`, Apify works out of the box for basic use, and with a thin caching layer for full balance-aware use.

**This means the Apify MCP server speaking the standard `_meta` protocol (gaps #1-#3 below) is the highest priority.** It unlocks interoperability with any x402 client, not just `mcpc`.

The standard patterns should be used as a **protocol reference** (402 response format, `_meta` keys, `structuredContent` structure) even though the server-side `createPaymentWrapper` cannot be used as-is (different settlement model).

---

## Protocol-level gaps in the proposal

### 1. Support payment via `_meta`, not just HTTP headers

**Proposal:** Payment travels in `PAYMENT-SIGNATURE` HTTP header only. MCP server extracts it in Express middleware.

**Coinbase reference:** Payment travels inside MCP protocol — `_meta["x402/payment"]` on the request, `_meta["x402/payment-response"]` on the response. No HTTP headers.

```typescript
// Coinbase: client sends payment in _meta
const callParams = {
  name: "get_weather",
  arguments: { city: "NYC" },
  _meta: {
    "x402/payment": paymentPayload,  // PaymentPayload object, not base64 string
  },
};
```

**Why it matters:** The HTTP-header approach only works with `mcpc` (which controls the transport). Most MCP clients (Claude Desktop, Cursor, etc.) can't set custom HTTP headers but can set `_meta` on `tools/call`. Supporting `_meta["x402/payment"]` as a fallback makes Apify compatible with any standard x402-aware MCP client — even if full balance tracking requires `mcpc`.

**Action:** `enrichRequestBody()` in `apify-mcp-server-internal` should check two locations in order:
1. `PAYMENT-SIGNATURE` HTTP header (primary, used by `mcpc`)
2. `params._meta["x402/payment"]` inside the JSON-RPC body (fallback, used by other MCP clients)

---

### 2. Support the call-then-retry client flow (the x402 standard)

**Proposal:** `mcpc` reads `_meta.x402.paymentRequired` from `tools/list` to know upfront which tools need payment. Attaches payment on first call.

**Coinbase reference:** Client calls the tool **without** payment first. If it gets a 402 (`isError: true` + `structuredContent`), it creates a payment and **retries**:

```typescript
// Standard x402 MCP client flow:
// 1. Call tool without payment
const result = await mcpClient.callTool({ name, arguments: args });

// 2. Check if 402
const paymentRequired = extractPaymentRequiredFromResult(result);
if (paymentRequired) {
  // 3. Create payment and retry
  const payload = await paymentClient.createPaymentPayload(paymentRequired);
  return callToolWithPayment(name, args, payload);
}
```

**Why it matters:** The call-then-retry pattern is what third-party x402 clients will implement. The `tools/list` metadata annotation is not part of the x402 standard — no external client will look for it.

**Action:**
- Keep `_meta.x402` tool annotations as a `mcpc`-specific optimization (avoids the wasted first call)
- But the core library **must also** return proper 402 responses via `structuredContent` when a paid tool is called without payment via MCP protocol — this is the baseline that standard x402 clients depend on

---

### 3. Adopt the standard 402 response format (`structuredContent` + `content[0].text`)

**Proposal:** Returns raw HTTP 402 with a flat JSON body: `{ x402Version, scheme, network, asset, minimumAmountUsd, payTo }`.

**Coinbase reference:** Returns a standard MCP tool result with dual format — `structuredContent` for smart clients, `content[0].text` as JSON fallback:

```typescript
// Standard 402 response format:
{
  structuredContent: {
    x402Version: 2,
    error: "Payment required",
    resource: {
      url: "mcp://tool/call-actor",
      description: "Tool: call-actor",
      mimeType: "application/json",
    },
    accepts: [{
      scheme: "exact",
      network: "eip155:8453",
      amount: "5000000",        // Atomic units (6 decimals for USDC)
      asset: "0x833589f...",    // USDC contract address
      payTo: "0xApifyWallet",
      maxTimeoutSeconds: 300,
      extra: { name: "USDC", version: "2" },
    }],
  },
  content: [{
    type: "text",
    text: JSON.stringify(paymentRequired),  // Fallback for basic clients
  }],
  isError: true,
}
```

**Why it matters:** Two issues:
1. The proposal's flat format is incompatible with standard x402 client libraries. The `accepts` array, `resource` field, `amount` in atomic units, and `extra` field are all required for `@x402/core` client to parse the response and create payment payloads.
2. Raw HTTP 402 is invisible to MCP clients — they expect JSON-RPC responses. Only `mcpc` understands HTTP 402.

**Action:**
- Keep HTTP 402 gate in `apify-mcp-server-internal` Express middleware for `mcpc`
- Add MCP-level 402 response in the **core library** using the standard `structuredContent` + `content[0].text` dual format with the correct `PaymentRequired` structure (including `accepts[]`, `resource`, atomic amounts)

---

### 4. Define the `_meta` response format for balance tracking

**Proposal:** Says "return payment response data in tool result `_meta`" but never specifies the format. `mcpc`'s balance-tracking state machine has no contract to implement against.

**Coinbase reference:** Defines the response format clearly:

```typescript
// Standard payment response in _meta:
{
  _meta: {
    "x402/payment-response": {
      success: true,
      transaction: "0xabc123...",
      network: "eip155:8453",
      payer: "0xClientWallet...",
    }
  }
}
```

**Action:** Define Apify's response format, extending the standard with balance info needed for the prepaid model:

```typescript
{
  _meta: {
    "x402/payment-response": {
      success: true,
      transaction: "0xabc123...",       // On-chain tx hash (first call only)
      network: "eip155:8453",
      payer: "0xClientWallet...",
      // Apify-specific extensions for prepaid balance model:
      remainingBalanceUsd: 3.42,
      initialBalanceUsd: 5.00,
      paymentId: "<sha256-of-signature>",
    }
  }
}
```

This is what `mcpc` reads to decide whether to reuse the current payment (Case B) or sign a new one (Case C). Standard x402 clients will ignore the extra fields but can still read `success` and `transaction`.

---

### 5. Document the settlement timing deviation

**Proposal:** Settlement happens during authentication, BEFORE the tool runs. Money moves on-chain before the Actor starts.

**Coinbase reference:** Verify BEFORE execution, settle AFTER. If the tool errors, settlement is skipped — user keeps their money:

```typescript
// Coinbase server: verify → execute → settle (only if success)
const verifyResult = await resourceServer.verifyPayment(payload, requirements);
const result = await handler(args, context);  // Execute tool

if (result.isError) {
  return result;  // Tool failed → NO settlement
}

const settleResult = await resourceServer.settlePayment(payload, requirements);
```

**Why Apify can't follow this pattern:** The "tool execution" (starting an Actor) returns immediately, but the actual cost accumulates over minutes/hours as the Actor runs. Settlement must happen upfront because:
- Apify needs the money as a prepaid balance before allowing Actor execution
- One settlement covers many subsequent tool calls (`get-actor-run`, `get-dataset-items`, etc.)
- The refund for unused balance is handled asynchronously by `AGENTIC_PAYMENTS_SETTLING_DAEMON`

**Risk:** If the first tool call fails immediately (Actor not found, invalid input, quota exceeded), the user's $5 is already on-chain and they must wait for the refund daemon.

**Action:**
- Document the deviation explicitly in the proposal and why it's necessary
- Add a guard: if the immediate API validation fails (before any Actor run is created), avoid settlement or return a clear error so `mcpc` knows not to consider this payment "active"

---

### 6. Handle batch requests

**Proposal:** The HTTP 402 gate in `processAndHandleRequest()` doesn't address Streamable HTTP batching — multiple `tools/call` messages in one HTTP request.

**Coinbase reference / xMCP:** Both handle this explicitly. xMCP rejects batches with multiple paid tools:

```typescript
const paidTools = toolNames.filter((name) => x402Registry.has(name));
if (paidTools.length > 1) {
  return {
    error: "Batch requests with multiple paid tools are not supported.",
  };
}
```

**Action:** Add a rule to the 402 gate: if a batch contains any paid tool, require `PAYMENT-SIGNATURE` for the whole batch. If a batch contains multiple paid tools, reject it. One payment per HTTP request.

---

### 7. Handle settlement failures explicitly

**Proposal:** Doesn't address what happens if on-chain settlement fails during `authenticateAgenticUser()`.

**Coinbase reference:** Returns a 402-format error with a descriptive message:

```typescript
catch (settleError) {
  return createSettlementFailedResult(
    resourceServer, toolName, config,
    settleError instanceof Error ? settleError.message : "Settlement failed",
  );
}
```

**Action:** In the API's `x402Client.authenticateAgenticUser()`, if `settlePayment()` fails, return a structured error that the MCP server can forward to the client. Don't return a generic 500 — the client needs to know settlement failed so it can retry with a new payment.

---

### 8. Handle x402 protocol v1 vs v2

**Proposal:** Payment requirements format mixes v1 and v2 fields without acknowledging protocol versioning.

**Both xMCP and Coinbase:** Handle both versions throughout:
- v1: `maxAmountRequired` field, network as string (`"base"`)
- v2: `amount` field, network as CAIP-2 chain ID (`"eip155:8453"`)

**Action:** The API's `x402Client` should inspect `paymentPayload.x402Version` and build matching `paymentRequirements`. Document which version Apify primarily targets (v2 recommended) while accepting v1 for backwards compatibility.

---

### 9. Include `maxTimeoutSeconds` in payment requirements

**Proposal:** The 402 response doesn't include `maxTimeoutSeconds`. Clients don't know how long a signed payment is valid.

**Coinbase reference:** Always includes it (default 300 seconds). The client uses it to invalidate stale payments.

**Action:** Include `maxTimeoutSeconds` in the `accepts` array entries. `mcpc` should use this to proactively discard expired payments rather than waiting for a facilitator rejection.

---

## Summary Table

| # | Gap | Severity | Action |
|---|---|---|---|
| — | Standard x402 MCP patterns don't fit Apify's prepaid/refund model | Context | Use as protocol reference only, not drop-in |
| 1 | Payment in `_meta` not just HTTP headers | High | Support `_meta["x402/payment"]` as fallback input |
| 2 | Call-then-retry is the standard flow | High | Core library must return MCP-level 402 via `structuredContent` |
| 3 | 402 response format non-standard | High | Adopt `structuredContent` + `content[0].text` + `accepts[]` |
| 4 | `_meta` response format undefined | Medium | Define `_meta["x402/payment-response"]` with balance info |
| 5 | Settlement timing deviation undocumented | Medium | Document why, add guard for immediate failures |
| 6 | Batch requests unhandled | Medium | Reject batches with multiple paid tools |
| 7 | Settlement failure handling missing | Medium | Return structured error, not generic 500 |
| 8 | v1/v2 protocol versioning ignored | Low | Support both, target v2 |
| 9 | `maxTimeoutSeconds` missing from 402 | Low | Include in `accepts` entries |

---

## References

- [Coinbase x402 SDK — `@x402/mcp` package](https://github.com/coinbase/x402/tree/main/typescript/packages/mcp) — official MCP client + server implementation
- [Coinbase x402 MCP examples](https://github.com/coinbase/x402/tree/main/examples/typescript) — client and server examples
- [xMCP x402 plugin](https://github.com/basementstudio/xmcp/tree/main/packages/plugins/x402) — third-party MCP framework with x402 support
- [x402 protocol docs](https://docs.x402.org/) — protocol specification
