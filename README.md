# swiggy-mcp-toy

A tiny Node client for **Swiggy's official MCP servers**. It does the full
OAuth 2.1 + PKCE handshake (with dynamic client registration), then lets you
list the live tools and run a demo search.

Free to prototype on `localhost` — no Swiggy approval needed. Only going to
production / real transactions is gated (India-only, invite-led).

## Servers

| Vertical  | Endpoint                      |
|-----------|-------------------------------|
| Food      | `https://mcp.swiggy.com/food` |
| Instamart | `https://mcp.swiggy.com/im`   |
| Dineout   | `https://mcp.swiggy.com/dineout` |

Auth server: `https://mcp.swiggy.com/auth` · scopes `mcp:tools mcp:resources mcp:prompts` · PKCE `S256`.

## Setup

```bash
npm install
```

## 1. Log in (once per ~5-day session)

```bash
node src/login.mjs food        # or: instamart | dineout
```

Opens Swiggy in your browser — sign in with **phone + OTP**. The token is saved
to `.swiggy/food.json` and reused on later runs. (This is the one step that
needs a human; it can't be automated.)

## 2. Dump the live tool catalog

```bash
node src/list-tools.mjs food   # or: all
```

Prints every tool with its signature and writes full JSON schemas to
`schema.food.json`. This is the ground truth the public docs don't publish.

## 3. Demo search (does not order)

```bash
node src/order-demo.mjs "biryani"
```

Discovers the search tool by name, runs it, and **stops before placing any
order**.

## Notes / gotchas

- Payments through MCP are **cash-on-delivery only** at launch; Dineout is
  free bookings only.
- No refresh handling beyond what the SDK does — when the ~5-day token expires,
  just re-run `login.mjs`.
- `localhost:8765` must be free (the OAuth callback listener). Change
  `CALLBACK_PORT` / `REDIRECT_URL` in `src/oauth-provider.mjs` if needed —
  `localhost` is whitelisted by Swiggy.
- Delete `.swiggy/` to force a fresh login.
