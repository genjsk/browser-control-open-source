# Browser Control 1.3.0

This release adds character-by-character typing, an opt-in tool for running JavaScript on authorized pages, and more complete browser snapshots.

## Changes since 1.2.0

- **Character-by-character input.** The new `browser_type_text` tool supports text fields, text areas, and editable content, with handling for Chinese text, emoji, and multiline input. It requires the target tab to be active and does not automatically submit forms. Quick fill remains available.
- **Input interruption reporting.** If focus changes, the connection drops, or typing is paused, the tool reports partial progress. It does not automatically replay the text or include it in logs.
- **Optional page scripts.** The new `browser_eval` tool can run JavaScript in a user-authorized page. Enable page script execution separately in the extension settings. Use it only on pages you are authorized to automate.
- **More complete snapshots.** The extension no longer limits snapshots to the first five interactive elements. Large pages may produce larger tool responses.

## Upgrading from 1.2.0

Replace the complete portable folder, then reload the extension from the updated location if it was loaded unpacked. Keep your existing data directory to preserve pairing and settings.

Typing and page scripts use the browser's debugger permission, which may prompt you to accept the new permission when updating the extension. Both features have separate consent switches in the extension settings. Start the local service from the control panel before connecting through Codex, DSH, or another MCP client.
