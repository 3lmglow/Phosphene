# Security

Phosphene is designed for one private user and one AI connection per deployment. The supported
production topology stores the SQLite database and private proof images on one persistent `/data`
volume.

## Supported version

Security fixes are provided for the latest 1.x release.

## Reporting a vulnerability

Do not open a public issue containing secrets, proof images, or exploit details. Contact the
repository owner privately with the affected version, reproduction steps, and impact. Remove all
real Phosphene data from the report.

## Deployment checklist

- By default, the first visitor who successfully submits the setup form claims the uninitialized
  instance. Open the new deployment immediately and do not share its URL before setup is complete.
- A random-looking hostname reduces casual discovery but is not an authentication boundary. Public
  TLS hostnames can be discovered through
  [Certificate Transparency](https://www.ietf.org/rfc/rfc9162.html) and other active scanning.
- If the URL is already public, predictable, or cannot be claimed immediately, set a unique
  `PHOSPHENE_SETUP_TOKEN` before exposing it. A value of at least 24 random characters is recommended.
- Mount a private persistent volume at `/data`; do not use an ephemeral directory.
- Keep the Phosphene website behind HTTPS.
- Do not expose the contents of `/data` through a static file server.
- Keep `PHOSPHENE_MCP_AUTH_MODE=token` on every public deployment. The `none` mode is only for an
  isolated private network or same-device loopback connection.
- Rotate the AI token immediately if it is copied into an untrusted client.
- Never place an AI token in the MCP URL, browser-side JavaScript, logs, screenshots, or a public
  repository. Use `Authorization: Bearer` or `X-Phosphene-MCP-Token` from a trusted client.
- Export a Phosphene ZIP and enable persistent-volume snapshots before upgrading.
- Treat deleting the service volume as a destructive operation: it contains both the database and
  proof images.
