# Grok-style Chat

## Private workspace access

The chat page and API require the shared access key configured by the server operator.

1. Add `APP_ACCESS_KEY` to your existing `.env` file (or create `.env` from `.env.example`) and set it to a long random secret known only to you. You can generate one with:

   ```powershell
   node -p "require('crypto').randomBytes(32).toString('base64url')"
   ```

2. Restart the server and open the app. Visitors must enter the access key at `/login` before they can load the chat or call its APIs.

Successful logins receive an HTTP-only, signed, SameSite=Strict session cookie that expires after 12 hours. Login attempts are rate-limited. The key is never sent to the browser except when the visitor submits it over the connection to sign in.

Use HTTPS whenever the app is reachable over a network. If HTTPS terminates at a trusted reverse proxy, set `TRUST_PROXY=true` so the session cookie receives the Secure attribute. Do not commit `.env`.
