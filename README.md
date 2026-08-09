# emdash-postal

[Postal](https://postalserver.io) email provider plugin for [EmDash CMS](https://emdashcms.com).

Delivers EmDash's system and plugin email (admin invites, magic links,
`ctx.email.send()` from other plugins) through your **self-hosted Postal
server** using Postal's HTTP API — no SMTP sockets, so it works in both
trusted (Node/Docker) and sandboxed (Cloudflare Workers) plugin modes.

## Installation

```bash
npm install emdash-postal
```

## Setup

Register the plugin in `astro.config.mjs`:

```typescript
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";
import postal from "emdash-postal";

export default defineConfig({
  integrations: [
    emdash({
      plugins: [postal()],
    }),
  ],
});
```

Then in the EmDash admin panel:

1. Open **Settings → Postal** and enter:
   - **Postal Server URL** — your Postal web origin, e.g. `https://postal.example.com`
   - **Server API Key** — an *API* type credential from Postal
     (*Server → Credentials → New Credential → Type: API*)
   - **From Address** — e.g. `My Site <noreply@yourdomain.com>`; the domain
     must be configured (and DKIM-verified) on that Postal server
2. Use **Send Test Email** on the same page to verify connectivity.
3. Select Postal as the provider under **Settings → Email**.

## How it works

The plugin registers EmDash's exclusive `email:deliver` transport hook and
posts each message to `POST {server}/api/v1/send/message` with the
`X-Server-API-Key` header. Postal-side failures (bad credential, unverified
domain, suppressed recipient) surface as delivery errors in EmDash.

Credentials are stored in the plugin's scoped KV storage in your EmDash
database — never in code or config files.

### Capabilities

| Capability                        | Why                                                                 |
| --------------------------------- | ------------------------------------------------------------------- |
| `hooks.email-transport:register`  | Registers the exclusive `email:deliver` transport                   |
| `network:request:unrestricted`    | The Postal host is user-configured, so no fixed allow-list possible |

## Requirements

- EmDash **0.32+**
- A reachable Postal server (v2/v3) with an API credential

## Development

```bash
npm install
npm run build      # tsdown → dist/
npm run typecheck
```

## License

MIT © [Undefined](https://undefined.charity)
