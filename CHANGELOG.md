# Changelog

## 1.1.0

- Add a native Codex plugin with portable and compatibility manifests, browser workflow guidance and the existing MCP tools.
- Install and enable the plugin through a dedicated local marketplace from the desktop panel.
- Share the existing local runtime, browser authorization and data directory; retain the exe, browser extension and DSH integration.
- Preserve unrelated Codex settings and safely transition only the owned legacy MCP table.
- Relocate generated Codex plugin paths with storage migration and support refreshing the local installation.

## 1.0.4

- Add Copy plugin address above Open plugin directory in the DSH dialog, for installing a local plugin by its directory.

## 1.0.3

- Migrate existing data when changing storage instead of only changing the path.
- Verify every copied file before switching locations and cleaning old data.
- Preserve pairing keys, port settings, logs and cache; relocate generated DSH paths.
- Reject nonempty destinations, overlapping paths and directory links; roll back on verification or configuration failure.
- Prevent reconnection during migration and prevent existing AI sessions from recreating the former directory.
- Exercise migration and reconnection through both the Settings button and the frozen Windows executable.

## 1.0.2

- Open directly into the main interface with the usual local data directory.
- Allow C: and all other writable drives; provide optional storage changes in Settings.
- Keep the current connection when canceling a directory change.
- Fall back to writable application-local storage if the default profile directory is inaccessible.
- Verify default startup, Settings changes, AI integration and the frozen portable build.

## 1.0.1

- Ask for a data directory before first use; Windows refuses C: and junctions resolving to C:.
- Never silently fall back to AppData; canceling directory selection exits without creating application state.
- Settings show, open and change the selected directory; a new computer asks again.
- Keep pairing state, logs, generated integrations and client configuration backups in the selected location.
- Fix AI integration startup when the former default profile directory is inaccessible.
- Test the frozen AI button, connection cycles, explicit selection and relocation with no system Node.js.

## 1.0.0

- Clean open-source layout with no personal paths, credentials or browser data.
- Windows portable package includes the GUI, Node.js and production dependencies.
- Standard per-user data directories on Windows, macOS and Linux.
- Relocatable application files and a stable per-user MCP entry point.
- Three-step onboarding, a single pairing code, port settings and AI integration dialogs.
- Locally generated GPT/Codex configuration and DSH plugin bundle.
- Source/release allowlists, leak checks, hashes and GitHub Actions workflows.
- Original anime icon in the executable, native title bar and taskbar.
