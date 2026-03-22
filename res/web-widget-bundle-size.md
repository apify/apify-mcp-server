# Web Widget Bundle Size Notes

The widget bundles in `src/web/dist` must stay self-contained, but the top-level
`@apify/ui-library` and `@apify/ui-icons` entrypoints are expensive to bundle.

## Why the imports look unusual

Some widget files import directly from `@apify/ui-library/dist/src/...` instead
of `@apify/ui-library`.

This is intentional:

- the top-level `@apify/ui-library` barrel re-exports the whole library
- that pulls in heavy transitive code such as floating UI, markdown/code helpers,
  and other components even when a widget only needs a few primitives
- direct module imports let esbuild include only the specific pieces we use

The same reasoning applies to avoiding heavy convenience components in bundle-hot
paths when a small local equivalent is enough.

## Current optimization rules

- Keep Apify UI styling and theme tokens.
- Prefer narrow `dist/src/...` imports over the top-level `@apify/ui-library`
  barrel in web widgets.
- Avoid heavyweight components in shared or frequently loaded widget paths when a
  small local implementation preserves the same UX well enough.
- Treat markdown rendering as a special cost center. If it changes, measure the
  bundle size impact again.

## Verified result

After these changes, the production widget bundles dropped roughly from:

- `actor-run-widget`: `~1.86 MB` to `~1.16 MB`
- `actor-detail-widget`: `~1.86 MB` to `~1.52 MB`
- `search-actors-widget`: `~1.87 MB` to `~1.53 MB`

The remaining larger payload in detail/search is mostly the markdown parsing
stack.
