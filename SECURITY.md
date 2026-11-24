# Security policy

## Supported versions

LinkBag is an early-stage project; only the latest `master` is supported.

## Threat model

- LinkBag has **no accounts or authentication**. Do not expose the API, console
  or archive port directly to the internet. Put authentication in front of a
  reverse proxy, or keep it on a trusted LAN/VPN.
- Archived pages are untrusted. They run on a separate origin from the API and
  are previewed in a sandboxed iframe. Do not reuse the archive origin for the
  console, because page scripts could then reach the API.
- Plugins run in the LinkBag process with full filesystem and network access.
  Install only plugins you have reviewed. User plugins start disabled.
- Backups can contain private pages, cookies rendered into HTML, images and
  personal data. Treat the data directory as sensitive.

## Reporting a vulnerability

Please use GitHub's **private vulnerability reporting** (Security → Report a
vulnerability) instead of opening a public issue. Include a minimal
reproduction and the affected version/commit. Avoid attaching real backups,
cookies, tokens or internal hostnames.

## Deployment checklist

- Keep `LINKBAG_HOST` and `LINKBAG_ARCHIVE_HOST` at `127.0.0.1` unless a reverse
  proxy is in front of them.
- Add authentication at the proxy for any remote access.
- Keep the console and archive on different origins when possible.
- Do not commit `data/`, `linkbag.env`, `.env`, reverse-proxy credentials or
  container configuration with server details.
- Keep Bun, Chromium and dependencies up to date.
