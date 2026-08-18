# Contributing to dsh-headroom

Thanks for your interest in dsh-headroom! This project is a derivative of
[Headroom](https://github.com/headroomlabs-ai/headroom) and is licensed under
Apache-2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

## Development setup

The plugin is intentionally dependency-free at runtime. You only need Node.js
>= 22 to run checks and tests locally.

```sh
# Syntax-check all plugin entry points
npm run check

# Run unit tests (no harness dependencies required)
npm test

# Compression quality / information retention / CCR reversibility verification
npm run verify

# apply() integration smoke test (requires @deepseek-ai/dsh-tools resolvable)
npm run verify:apply
```

## Project layout

```text
lib/
  index.js        dsh plugin entry: post-execute hook + headroom_retrieve /
                  headroom_compress / headroom_stats tools
  compress.js     content routing and deterministic compressors
  kompress.js     Kompress-style ML text compression pipeline (pure JS port)
  ccr.js          CCR store: in-memory + debounced persistence
scripts/          verification scripts
tests/            unit tests
```

## Submitting changes

1. Create a feature branch from `main`.
2. Make focused changes and add tests when behaviour changes.
3. Run `npm run check` and `npm test`.
4. Commit with a clear message and open a pull request.

## License

By contributing, you agree that your contributions are licensed under the same
Apache-2.0 terms as the rest of the project.
