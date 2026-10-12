# Grok-style Chat

## Private workspace access

The chat page and API require the shared access key configured by the server operator.

1. Add `APP_ACCESS_KEY` to your existing `.env` file (or create `.env` from `.env.example`) and set it to a long random secret known only to you. You can generate one with:

   ```powershell
   node -p "require('crypto').randomBytes(32).toString('base64url')"
   ```

   To allow a second, chat-only key, set `APP_ACCESS_KEY_2` to a different secret (for example, `404`). That key can use the chat but cannot open analytics; only `APP_ACCESS_KEY` can access the dashboard. Keep both values private and do not commit `.env`.

2. Restart the server and open the app. Visitors must enter either configured access key at `/login` before they can load the chat or call its APIs.

Successful logins receive an HTTP-only, signed, SameSite=Strict session cookie that expires after 12 hours. Login attempts are rate-limited. The key is never sent to the browser except when the visitor submits it over the connection to sign in.

Use HTTPS whenever the app is reachable over a network. If HTTPS terminates at a trusted reverse proxy, set `TRUST_PROXY=true` so the session cookie receives the Secure attribute. Do not commit `.env`.

## Usage analytics

Open `/analytics` after signing in with `APP_ACCESS_KEY` to see anonymous active-user, page-view, and unique-browser counts. The `APP_ACCESS_KEY_2` chat-only key cannot view analytics, including through a direct URL or API request. Active users are browsers that have checked in during the last 90 seconds. These live counters are held in one server process's memory and reset when it restarts; on serverless or multi-instance hosting, they are not deployment-wide totals.

The dashboard can analyze Apache/Nginx common or combined access logs pasted into the page or selected from a `.log`/`.txt` file (up to 5 MB). Log analysis runs in the browser; raw logs and IP addresses are not sent to the server. Live counts use random browser identifiers and do not record IP addresses.

## Large image and video uploads

The chat accepts up to 50 MB of original attachments per conversation and caps each JSON chat request at 60 MB. The Express JSON parser defaults to 64 MB; override it with `CHAT_BODY_LIMIT` (for example, `100mb`) when your host permits larger requests. The browser compresses images and samples videos before sending them.

The hosting platform and any reverse proxy must also allow requests at least as large as the configured parser limit. Serverless platforms such as Vercel enforce their own fixed function payload limit, which cannot be raised with `CHAT_BODY_LIMIT`; this app's larger request setting therefore requires deploying the Express server on a host that supports configurable request-body limits. Deploy the updated code there and configure the platform's body-size limit as well.
