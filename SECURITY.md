# Security

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Use GitHub's private report: the **Security** tab of this repository, then **Report a vulnerability**. If that option is not there, open an issue titled "Security contact request" with no details, and the maintainer will arrange a private channel.

Include what you found, how to reproduce it and what an attacker gains. Fixes go to `main`. This project is at version 0.x, and only the latest `main` is supported.

## What the code defends

This app handles photos of people's faces and lets an automated agent act on a person's behalf, so these are the properties it tries to keep.

- **Tokens.** Session tokens are HMAC-signed, bound to one session and one role, and sent only in the `Authorization` header (a token in a query string is ignored). A token for another session, or for a session that no longer exists, gets `404` and learns nothing. The client's token travels in the URL fragment and is removed from the address bar.
- **Consent.** No photo tool runs until the client has confirmed they are 18 or older and agreed to photo analysis. The agent has no route to give consent for them.
- **Photos.** They are decoded in one place, re-encoded (EXIF, GPS and alpha are dropped), held only in memory and deleted when the session ends or the client deletes them. Hosts cannot read image bytes. The agent can only if the session was created with `agent_vision`.
- **Outbound requests.** The YouCam client follows only public https links, fetches result images only from YouCam's storage hosts, refuses redirects and bounds every size and time. A response from YouCam cannot aim a request at an internal address.
- **Browsers.** CORS answers only the origins the operator lists, and never `*` (the public manifest is the one exception). Framing is limited to those origins with `frame-ancestors`. The page that embeds the app receives three messages and sends one, to and from one exact origin.
- **Abuse.** Every session has a budget of provider units, rate limits on tool calls and messages, a bounded request size, and an event log of fixed length. The server has a daily cap on YouCam tasks.
- **Secrets.** They come from the environment only. In production the server refuses to start without a signing secret (32 or more characters) and a public URL, and without a host key unless standalone demo sessions are on. Logs record the route template and status, never a token, a photo or message text.

## What the operator must do

- Serve the app over HTTPS. The app does not terminate TLS.
- Keep `PPRO_SIGNING_SECRET`, `PPRO_HOST_KEY` and `YOUCAM_API_KEY` in a secret manager. Never commit `.env`; only `.env.example` is tracked. Rotating the signing secret ends every session.
- Keep the host key on your servers. Give the agent token only to the advisor's runtime, and the client token only to that client's browser.
- List exact origins in `PPRO_ALLOWED_ORIGINS` and only for pages that embed the app.
- Decide whether to allow `agent_vision`. It sends the client's face to whatever model the agent runs on, which is a consent question for your product.
- Run one instance, or route each session to the instance that holds it.

## Known limits

- Rate limits and the YouCam daily cap are counted per process.
- There is no audit log. A host that needs one should record what it does with its own key.
- The agent's text is cleaned and checked against a narrow content floor, but it is still model output. Treat it as untrusted wherever you render it outside this app.
