# Tests

This directory contains **unit** and **integration** tests for the `actors-mcp-server` project.

## Unit tests

Unit tests are located in the `tests/unit` directory.

To run the unit tests, you can use the following command:
```bash
npm run test:unit
```

## Integration tests

Integration tests are located in the `tests/integration` directory.
To run the integration tests, you need to have the `APIFY_TOKEN` environment variable set.
Also, the following Actors need to exist on the target execution Apify platform:
```
ALL DEFAULT ONES DEFINED IN consts.ts AND ALSO EXPLICITLY:
apify/rag-web-browser
apify/instagram-scraper
apify/python-example
```

To run the integration tests, you can use the following command:
```bash
APIFY_TOKEN=your_token npm run test:integration
```

## Integration test conventions

- Keep test names sentence-style and behavior-focused (for example: `should return ...`).
- Avoid ad-hoc fixed sleeps in assertions. Prefer polling and assertion-based checks.
- Reuse integration helpers from `tests/integration/utils` for repeated wait/poll patterns.
- Apply retries only to known unstable cases and keep them scoped per test (`retry: 1`).
