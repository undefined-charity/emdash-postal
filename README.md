# emdash-postal

Postal email provider plugin for [EmDash CMS](https://emdashcms.com). Delivers every email EmDash sends — invites, magic links, plugin mail — through your self-hosted [Postal](https://postalserver.io) server's HTTP API.

## How it works

Every message is **queued, never sent inline**. The `email:deliver` hook writes the message to plugin storage and returns immediately; a job runs once a minute and sends whatever is waiting through `POST /api/v1/send/message`.

That design comes from a production incident. A plugin hook runs under a wall-time budget, and a single Postal call can outlast it: the message went out, the hook was killed, the caller saw an error for a delivery that had succeeded — and retrying "the failure" sent the same email again. One invite, two error dialogs, three emails. With the queue, nothing in the request path ever waits on Postal, and a slow reply cannot become a duplicate.

The cost is latency: on Cloudflare Workers the finest cron granularity is one minute, so an email is usually on its way within 30 seconds and always within 60.

### Retries

| failure | what happens |
| --- | --- |
| network error, HTTP 5xx, rate limit | retried after 1, 2, 4, 8 and 16 minutes, then given up on |
| Postal refused it (bad address, bad credential, parameter error) | given up on immediately — retrying repeats the refusal |
| no reply within 20 seconds | treated as **unconfirmed**: Postal may have accepted it, so it gets exactly one more try after five minutes, then is given up on rather than risk more duplicates |

Given-up messages appear on the plugin's admin page with the reason, and can be retried or discarded by hand.

## Install

```bash
npm install github:undefined-charity/emdash-postal
```

```js
// astro.config.mjs
import postal from "emdash-postal";

export default defineConfig({
  integrations: [emdash({ plugins: [postal()] })],
});
```

Then in the admin: **Plugins → Postal → Settings**

| setting | value |
| --- | --- |
| Postal server URL | your server's origin, e.g. `https://postal.example.com` |
| Server API key | Postal → your mail server → Credentials, type "API" |
| From address | e.g. `Bad Dog <hello@example.com>` — the domain must be set up in Postal |

If more than one email provider plugin is installed, EmDash needs to be told which one delivers: set the `emdash:exclusive_hook:email:deliver` setting to `emdash-postal`.

The **Postal** admin page shows whether the drain job is running, what is waiting, what has been given up on, and has a "queue a test email" button that proves the whole path — settings, queue, job and credentials — in one go.

## Message extras

EmDash's `EmailMessage` has `to`, `subject`, `text` and `html`. The plugin also passes through, when a sender attaches them:

- `cc` — string or string[]
- `replyTo` — string
- `headers` — `Record<string, string>`, e.g. `List-Unsubscribe` / `List-Unsubscribe-Post` for RFC 8058 one-click unsubscribe. Names are validated and CR/LF stripped from values, so a caller cannot inject headers.

## Upgrading from 0.3

0.4 is a **native** plugin (it runs in-process, not in the plugin sandbox) so the drain job can declare a budget that fits a real Postal call. Nothing changes in `astro.config`, and settings are stored under the same keys, so an existing configuration carries over. The settings form moves from the plugin page to **Plugins → Postal → Settings**.

## Development

```bash
npm install
npm run typecheck
```

The package ships TypeScript source; the consuming site's build compiles it.

## License

MIT
