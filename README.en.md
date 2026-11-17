# Browser Control

[中文说明](README.md)

A local browser extension and MCP bridge with a desktop connection panel. An AI client can read, click, fill, type, scroll, navigate and capture **only the tabs you authorize**. Works with local-MCP-capable GPT/Codex sessions, DeepSeek Harness and other stdio MCP clients.

## Windows quick start

1. Download the Windows x64 portable ZIP from this repository's Releases. Extract the entire folder and run `BrowserControl.exe`. Python and Node.js are included.
2. Click **Connect**, then **Pair browser**. Load the `extension` folder at `chrome://extensions` or `edge://extensions` in developer mode. Copy the pairing code from the panel into the extension settings.
3. Click **Connect AI → Install to Codex** to install the native Codex plugin, then restart Codex or start a new chat. Generic MCP JSON and DSH integration remain available. Open a normal website and authorize the tab through the extension toolbar popup.

The Codex plugin shares the existing local service. The exe, browser extension and desktop storage controls remain available. See [native plugin setup](docs/codex-plugin.md). Installation uses the local Codex CLI and was verified with version 0.142.1.

Only the control panel starts and stops the local service. Codex, DSH and other MCP clients merely forward stdio requests: if the service is not running they return a clear "local service is not running" error instead of starting another listener. Each tool call verifies the AI instance identity, the configured port against the live service port, the pairing credentials, the extension connection and whether that instance is paused. The panel's **AI access** area lists every installed instance with client, transport, port, installed/online/offline/paused status and last call time, and can pause or resume a single instance; pausing is enforced by the service and persisted. There is no cumulative call, session or daily quota; only per-request timeouts remain, and timed-out writes are never replayed. Browser snapshots return every interactive element on the page instead of truncating to a fixed count.

`browser_type_text` is an optional character-by-character typing tool. It requires explicit consent in the extension settings and Chrome's `debugger` permission (Chrome may show a debugging infobar, and `chrome://extensions` may ask you to accept the new permission after an update); the quick `browser_fill` tool remains available without it. The target tab must be active (`browser_select_tab` first). If the control was not already focused, typing starts at the end of its value; if it was focused, the current caret or selection is kept and typed text replaces the selection. Only text-like inputs (text/search/email/url/tel), textareas and contenteditable elements are supported; number/date controls and password/file inputs are rejected. ASCII characters are sent as browser-level keydown/keypress/keyup events; Chinese, emoji and other characters without a reliable single-key mapping use the text/IME input path. Newlines are skipped in single-line inputs and inserted in textareas/contenteditable elements, and the tool never presses Enter to submit. On failure it reports how many characters were typed and does not replay the text; input text is never logged or returned.

Launch directly into the main interface. Settings can open or change the data directory; C: and other writable drives are allowed. The current interface is Chinese. Keep the entire portable folder together; copying the executable alone is insufficient. The Windows executable cannot run on macOS or Linux.

Changing storage migrates and verifies the existing data before removing old files, preserving pairing credentials and settings. Close AI clients using the browser tools first; refresh their MCP configuration after migration. Nonempty destinations are never overwritten.

## Source / macOS / Linux

Install Node.js 22+, then run `npm ci --cache .local/npm-cache` and `npm start`. Optionally run `node scripts/paths.mjs --select <chosen-directory>` to change storage. Stop with `npm run stop`. macOS/Linux GUI and browser integration require validation on the target platform; Windows is the locally tested desktop target.

## Data and portability

Pairing credentials, logs and generated integration files are created in the active data directory, never included in releases. A new computer uses its own default storage: pair the extension and configure its AI client again. After moving the full application on the same computer, open the new location and click Connect to update the runtime pointer. Reload the unpacked extension from its new location too.

Defaults: `%LOCALAPPDATA%/BrowserControl` on Windows, `~/Library/Application Support/BrowserControl` on macOS and `$XDG_STATE_HOME/browser-control` (normally `~/.local/state/browser-control`) on Linux. An inaccessible default falls back to `.local/state` beside the app, with the active location shown in the interface. A private `.local/storage-location.json` records a custom location and a machine identity hash. `BROWSER_CONTROL_DATA_DIR` explicitly overrides storage. Browser profiles and AI clients retain their own storage policies.

## Development

```sh
npm ci --cache .local/npm-cache
npm run check
npm test
npx playwright install chromium
npm run test:browser
```

For a Windows portable package: install `requirements-build.txt`, run `python scripts/build-gui.py`, then `npm run package:portable`. `npm run package:source` creates a clean source ZIP. See [release documentation](docs/releasing.md).

The service binds to loopback, checks authentication and extension origins, pauses on disconnection, and does not replay timed-out writes. Typing requires a user opt-in and is performed through Chrome's debugger API only while a request is running; the debugger connection is released afterwards. Page content and screenshots returned as tool results may be sent to your AI provider. See [security](SECURITY.md) and [integration](docs/integrations.md) documentation.

MIT licensed. The bundled original mascot artwork was AI-generated. Third-party packages retain their own licenses.
