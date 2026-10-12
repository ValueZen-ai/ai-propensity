# Converter

`ai-propensity-converter.html` is a single web page that turns a ChatGPT or Claude.ai data export into the same evidence file `adapters/chatgpt` and `adapters/claude-web` produce, without Python. People download it (the **Download raw file** button on its GitHub page) and open it from disk. See the main [README](../README.md#-use-chatgpt-or-claudeai-no-install-no-python).

## Layout

| File | What it is |
|---|---|
| `src/convert.js` | Line-for-line port of the two export adapters plus `core/event_schema.py` and the payload shape from `core/export.py` |
| `src/zip.js` | Read-only zip reader built on the browser's `DecompressionStream`. It reads only the `conversations*.json` entries, straight from disk, so large exports with media never load fully into memory |
| `src/ui.js`, `src/page.html`, `src/page.css` | The page |
| `build.mjs` | Inlines everything into one file and writes a CSP that allows only that script and stylesheet (by SHA-256) and no network |
| `ai-propensity-converter.html` | Build output. **Don't edit it by hand.** It's committed because it's what people download |
| `test/cli.mjs` | Runs the converter's pipeline from the command line: `node converter/test/cli.mjs <export.zip \| folder \| conversations.json> [...]` |

## Changing it

1. Edit `src/`. If you change what an adapter extracts, change `convert.js` (or the Python) in the same commit, and keep `PARSER_VERSIONS` in step with each adapter's `PARSER_VERSION`.
2. `node converter/build.mjs`
3. `python3 -m pytest tests` (includes `test_converter_parity.py`, which needs Node 20+) and `node --test converter/test/*.test.mjs`
4. Commit `src/` and the rebuilt HTML together. CI runs `build.mjs --check` and fails if they differ.

The page must keep working when opened from disk (`file://`). That means one file and no Web Workers (Chrome blocks them for disk-opened pages). Also avoid inline `style="..."` attributes and inline event handlers, because the hash-based CSP blocks them.

## Verifying a downloaded copy

- Rebuild it yourself from the source (`node converter/build.mjs`) and diff it against your copy.
- Open it with the network off, or watch your browser's Network tab. The CSP in the page's first lines (`default-src 'none'; connect-src 'none'`) blocks every request.
