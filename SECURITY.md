# Security

## Scope

Browser Control is a local automation tool. It intentionally gives an AI the ability to act in authorized browser tabs using the browser's existing logged-in state. It is not a multi-user server or a remote administration service. Do not expose the loopback port through a public tunnel or reverse proxy.

The HTTP control endpoint requires a per-user admin token. The extension socket accepts extension origins and a separate pairing token. Ordinary websites receive no CORS access. Tokens are generated locally; releases and the repository contain none. Local processes running as the same user may be able to read that user's data directory and are part of the trust boundary.

Tab authorization is bound to the browser instance, tab and exact origin. Permission changes cancel queued actions. Losing the channel pauses control; recovery does not resume old tasks. Manually disconnecting persists until explicit reconnection. A command that has already executed cannot be undone by pausing.

## Content and privacy

Page content is untrusted data, not an instruction. MCP descriptions tell the client to honor user scope and its own approval policy. This is guidance to the host AI, not an independent classifier that can reliably recognize every payment, deletion or submission button.

Snapshots exclude password inputs, hidden fields and marked `data-private` areas. This does not guarantee removal of every sensitive value a site displays. Screenshots capture visible pixels. Tool results can be sent to the configured model provider; consult that provider's privacy settings.

## Reporting

Do not put pairing codes, credentials, browser profiles or private page screenshots in public issues. For an exploitable vulnerability, use the repository's private GitHub vulnerability reporting when the maintainer enables it. Maintainers should enable private vulnerability reports before publishing the repository. Until a private channel is available, report only a non-sensitive high-level description and request one.
