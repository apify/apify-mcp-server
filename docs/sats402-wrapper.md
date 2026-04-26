# Optional SATS-402 Wrapper Example

SATS-402 is a Bitcoin-native paid-delivery pattern for HTTP 402-style API and MCP responses. The response body is encrypted before delivery, and the paying agent decrypts it locally only after a Lightning preimage is observed.

Apify already leads in agentic payments with x402/Skyfire. SATS-402 demonstrates an optional Bitcoin-native paid-delivery path for Actor results using Lightning preimage-locked response delivery.

An unofficial permissionless wrapper proof for Apify Actor results is available here:

https://github.com/Lumen-Founder/apify-sats402-wrapper

Related discussion:

https://github.com/apify/apify-mcp-server/issues/756

The wrapper keeps Apify as the upstream Actor platform. It does not bypass Apify auth, billing, API tokens, usage limits, or rate limits. Real upstream mode uses a normal `APIFY_TOKEN`, with `APIFY_API_TOKEN` accepted as an alias, before SATS-402 locks response delivery.

Demo commands from the standalone proof:

```bash
npm run apify:demo:fixture
export APIFY_TOKEN=...
npm run apify:demo -- --actor apify/rag-web-browser --query "bitcoin lightning agent payments"
```

The proof path uses local real-LND regtest to create a hold invoice, pay a merchant invoice, observe the Lightning preimage, settle the agent-side hold invoice with the same preimage, and decrypt the Actor dataset locally. It reports `custody: false` and `credit_extended: false`.

This example is optional and unofficial. Maintainers should feel free to move, rename, edit, reduce, or close it to fit the preferred Apify docs/examples structure.
