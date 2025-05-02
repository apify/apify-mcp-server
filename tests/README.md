# Tests

This directory contains **unit** and **integration** tests for the `actors-mcp-server` project.

# Unit Tests

Unit tests are located in the `tests/unit` directory.

# Integration Tests

Integration tests are located in the `tests/integration` directory.
In order to run the integration tests, you need to have the `APIFY_TOKEN` environment variable set.
Also following Actors need to exist on the target execution Apify platform:
```
ALL DEFAULT ONES DEFINED IN consts.ts AND ALSO EXPLICITLY:
apify/rag-web-browser
apify/instagram-scraper
apify/python-example
```
