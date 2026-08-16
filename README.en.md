# dsh-headroom

> Headroom-inspired automatic context compression for **DeepSeek Harness (dsh)**.

Tool outputs are compressed before they reach the model. JSON, search results, logs,
tabular data, and long prose each go through a dedicated deterministic compressor.
Every **lossy** compression stores the exact original in a local CCR store and injects a
short marker, so the model can call `headroom_retrieve(id=…)` to recover the original
byte-for-byte.

```text
 tool body settles
        │
        ▼
 tools/post-execute   ← dsh-headroom compresses here
        │
        ▼
 tool/result enters session log / model history (compressed content + CCR marker)
        │
        ▼
 model calls headroom_retrieve(id=…) when it needs the exact original
```

## Features

- **Automatic tool-output compression** via the `tools/post-execute` seam.
- **Content router with specialized compressors**:

  | Content type | Strategy |
  |--------------|----------|
  | JSON array / object | SmartCrusher-style pivot: `_keys` + `_rows` + `_common`, long-cell truncation |
  | grep / ripgrep output | Fold by file: `file (N matches)` + `line[:col]: rest` |
  | build / test / log output | Consecutive-repeat folding + `error/fail/exception/assert` context preserved |
  | CSV / TSV / markdown tables | Keep header + first/last rows, offload the middle |
  | Long prose | Head/tail truncation + CCR marker |
  | Code | **Not compressed** (no AST compressor in this JS port) |

- **Reversible compression (CCR)**: `headroom_retrieve` / `headroom_compress` /
  `headroom_stats` mirror Headroom's MCP surface.
- **Persistence**: CCR store defaults to `<DSH_HOME>/storages/dsh-headroom-ccr.json`
  (1 s debounce, atomic replace, configurable TTL and entry cap).
- **Safe defaults**: short text, code, error outputs, excluded tools, and the plugin's
  own tools are never compressed.
- **Cross-platform**: pure JavaScript + Node built-ins, no native build step.
  The CI matrix lives in [`.github/workflows/ci.yml`](./.github/workflows/ci.yml).

## How it works

```mermaid
flowchart LR
  A[ToolRuntime execution] --> B[tools/post-execute]
  B --> C{total text chars >= minChars?}
  C -- no --> Z[return unchanged]
  C -- yes --> D[ContentRouter]
  D --> E[json] --> E1[SmartCrusher pivot]
  D --> F[search] --> F1[search fold]
  D --> G[log] --> G1[repeat fold + error keep]
  D --> H[tabular] --> H1[head/tail keep]
  D --> I[text] --> I1[head/tail + CCR]
  D --> J[code] --> Z
  E1 & F1 & G1 & H1 & I1 --> K{compressed + marker smaller?}
  K -- no --> Z
  K -- yes --> L[write CCR store]
  L --> M[replace decision.content]
  M --> N[model sees compressed content + retrieve marker]
```

- `lib/compress.js` — pure-function compressors, no `node:*` imports.
- `lib/ccr.js` — in-memory CCR store with debounced persistence.
- `lib/index.js` — dsh plugin entrypoint.

## Compression results

### Stress configuration

`node scripts/verify-compress.mjs` with `minChars=120, maxRows=40, maxCellChars=80, maxTextChars=400`:

| Sample | Type | Before (chars) | After (chars) | Saved |
|--------|------|--------:|--------:|-----:|
| JSON array, 200 rows | json | 62 491 | 9 302 | **85.1%** |
| grep results, 270 hits | search | 10 772 | 4 603 | **57.3%** |
| log, 180 lines | log | 3 909 | 1 125 | **71.2%** |
| CSV, 201 lines | tabular | 19 814 | 3 029 | **84.7%** |
| prose, 400 segments | text | 29 506 | 546 | **98.1%** |
| code | code | 493 | 493 | 0% (protected) |
| short text | text | 19 | 19 | 0% (below threshold) |

> Token estimates in the script use `chars / 4`; real token counts depend on the model
> tokenizer. Every lossy compression stores the original, so nothing is unrecoverable.

### Default configuration

With defaults (`minChars=600, maxRows=80, maxCellChars=200, maxTextChars=2400`):

| Sample | Type | Saved |
|--------|------|-----:|
| JSON array, 200 rows | json | 65.6% |
| grep results, 90 hits | search | 41.3% |
| log, 180 lines | log | 56.8% |
| CSV, 201 lines | tabular | 59.8% |
| prose, 400 segments | text | 94.7% |

### Effectiveness safety

`scripts/verify-compress.mjs` also asserts:

1. Structured facts (JSON keys/counts, file groups, `ERROR/WARN` lines) remain visible
   after compression.
2. Code, short text, and error outputs stay byte-identical.
3. For every lossy compression, `headroom_retrieve` returns the exact original.
4. A `NEEDLE-42` fact hidden in the omitted middle of prose is absent from the
   compressed view but fully recoverable via CCR.

`scripts/verify-apply.mjs` (requires `@deepseek-ai/dsh-tools` resolvable) verifies the
real `apply()` surface: the post-execute listener is installed, a large grep output is
compressed and retrievable, and excluded/own/code/error/short outputs are untouched.

## Installation

### Requirements

| Item | Requirement |
|------|-------------|
| Node.js | `>= 22.0.0` |
| DeepSeek Harness | `>= 0.0.1-rc.5 < 0.1.0` |
| Package manager | `pnpm >= 11` recommended |
| OS | Windows / macOS / Linux |

### Recommended

Install directly from GitHub (same command on Windows / macOS / Linux):

```bash
dsh plugin --profile web add github:giter00/dsh-headroom
```

If `dsh` is not on PATH, invoke the profile CLI directly with the same argument:

```bash
# Windows PowerShell
node "$env:USERPROFILE\.dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js" plugin --profile web add github:giter00/dsh-headroom

# macOS / Linux
node "$HOME/.dsh/profiles/node_modules/@deepseek-ai/dsh/lib/bin.js" plugin --profile web add github:giter00/dsh-headroom
```

> pnpm pulls the repository's default branch (`main`) and reconciles the
> `dsh-headroom` bundle into the profile automatically.

### Manual

Edit `<DSH_HOME>/profiles/web/package.json`:

```jsonc
{
  "dependencies": {
    "dsh-headroom": "github:giter00/dsh-headroom"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "dsh-headroom"
      ]
    }
  }
}
```

Then:

```bash
cd "$DSH_HOME/profiles/web"
pnpm install
```

Restart dsh.

### Uninstall

```bash
dsh plugin --profile web remove dsh-headroom
```

## Configuration

Override via `cordis.patch.yml`:

```yaml
- id: dsh-headroom
  config:
    enabled: true
    minChars: 600
    maxRows: 80
    maxCellChars: 200
    maxSearchMatchesPerFile: 60
    maxLogLines: 80
    maxTextChars: 2400
    maxTabularLines: 80
    excludeTools: []
    includeErrors: false
    ccr:
      enabled: true
      persist: true
      ttlMs: 86400000
      maxEntries: 2000
```

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `true` | Master switch |
| `minChars` | `600` | Minimum text-block length before compression is considered |
| `maxRows` | `80` | Maximum JSON pivot rows kept |
| `maxCellChars` | `200` | Cell truncation length for JSON/search |
| `maxSearchMatchesPerFile` | `60` | Search hits kept per file |
| `maxLogLines` | `80` | Log head/tail budget |
| `maxTextChars` | `2400` | Prose head/tail budget |
| `maxTabularLines` | `80` | Tabular head/tail budget |
| `excludeTools` | `[]` | `*` wildcard patterns; matched tools are never compressed |
| `includeErrors` | `false` | Compress error tool outputs too |
| `ccr.enabled` | `true` | Disable to turn off lossy compression entirely |
| `ccr.persist` | `true` | Persist the CCR store to disk |
| `ccr.ttlMs` | `86400000` | Original-content retention |
| `ccr.maxEntries` | `2000` | Maximum store entries |

## Model-visible tools

| Tool | Arguments | Purpose |
|------|-----------|---------|
| `headroom_retrieve` | `id` | Recover the exact original of a compressed tool result |
| `headroom_compress` | `text` | Compress arbitrary text |
| `headroom_stats` | none | Show process compression statistics |

Marker format:

```text
[headroom: search-fold 12345→987 chars; retrieve full original with headroom_retrieve(id="hr:0123456789abcdef")]
```

## Development

```bash
node --check lib/index.js && node --check lib/compress.js && node --check lib/ccr.js
node tests/compress.test.js
node scripts/verify-compress.mjs
node scripts/verify-apply.mjs   # requires @deepseek-ai/dsh-tools
```

## Differences from Headroom

| Dimension | Headroom | dsh-headroom |
|-----------|----------|--------------|
| Integration | proxy / wrap / MCP / SDK | native dsh plugin on `tools/post-execute` |
| JSON | SmartCrusher (Rust core) | JS pivot (`_keys` / `_rows` / `_common`) |
| Code | AST CodeCompressor | skipped by default |
| Text | Kompress-v2-base ML model | head/tail truncation + CCR |
| Reversibility | CCR | local CCR store + `headroom_retrieve` |
| Native deps | some extras | none |

## License

[MIT](./LICENSE)

## Acknowledgements

Design and compression strategies are inspired by
[Headroom](https://github.com/headroomlabs-ai/headroom) (Apache-2.0).
