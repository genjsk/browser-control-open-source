# Client integrations

Integration code lives in `scripts/integration.mjs`.

The desktop panel generates machine-local MCP JSON, an optional managed Codex configuration block, and a DSH Cordis bundle. No personal connection files, absolute machine paths or authentication tokens are checked into this directory.

Run `node scripts/cli.mjs info --json` to generate local MCP and pairing information (contains the private pairing code; do not publish its output). Run `node scripts/cli.mjs prepare-dsh --json` to generate the DSH bundle in the user data directory. See [client documentation](../docs/integrations.md).
