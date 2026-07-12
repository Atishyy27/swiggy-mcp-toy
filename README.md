# swiggy-mcp-toy // FEASTMODE

Give an AI agent a craving and a budget. Watch it raid real kitchens, crack real
coupons, and build a cart in real time - on **Swiggy's official MCP**. A neon
mission-control UI, plus a clean client that does the full OAuth handshake and
drives the real tools.

Not affiliated with Swiggy. Free to prototype on `localhost` (no approval needed);
production / real transactions are gated (India-only, invite-led).

```bash
npm install
npm run ui      # then open http://localhost:3000  -> click CONNECT SWIGGY
```

## What you get

- **FEASTMODE UI** (`public/index.html`) - the shareable showpiece.
  - **DEMO mode**: fully client-side, no login, no keys. Instantly playable.
  - **LIVE mode**: streams a real mission from your connected Swiggy account.
- **In-app OAuth**: one **CONNECT SWIGGY** button. Popup phone+OTP login, the
  backend catches the callback and saves a ~5-day token. No terminal needed.
- **LIVE TOOLS browser**: once connected, see the real tool schemas (names,
  params, required flags) straight from the MCP.
- **Three verticals**: Food / Instamart / Dineout, each its own MCP server and
  its own connection.
- **CLI client** (`src/*.mjs`): `login`, `tools`, `order` scripts if you prefer
  the terminal.

## The three MCP servers

| Vertical  | Endpoint                       | Live tools |
|-----------|--------------------------------|-----------|
| Food      | `https://mcp.swiggy.com/food`  | 18 |
| Instamart | `https://mcp.swiggy.com/im`    | 14 |
| Dineout   | `https://mcp.swiggy.com/dineout` | 8 |

Auth server `https://mcp.swiggy.com/auth` - OAuth 2.1 + PKCE (S256), dynamic
client registration (public `client_id: swiggy-mcp`), scopes
`mcp:tools mcp:resources mcp:prompts`, ~5-day token, refresh supported.

### Real Food tools (pulled live)

`get_addresses`, `search_restaurants`, `search_menu`, `get_restaurant_menu`,
`get_food_cart`, `update_food_cart`, `flush_food_cart`, `place_food_order`,
`fetch_food_coupons`, `apply_food_coupon`, `get_food_orders`,
`get_food_order_details`, `track_food_order`, `get_food_delivery_status`,
`get_payment_options`, `check_payment_status`, `confirm_order`, `report_error`.

Every ordering tool needs an `addressId` from `get_addresses` - that is your
delivery location. Payments are not COD-only: there is a full UPI flow
(`get_payment_options` / `check_payment_status` / `confirm_order`).

## How LIVE mode works

`server.mjs` (SSE) -> `src/agent.mjs`:

1. `get_addresses` - your real saved addresses (pick one in the UI).
2. `search_restaurants(addressId, query)` - real restaurants near you
   (veg-only via the VEG toggle).
3. best-rated spot, `get_restaurant_menu` (2 pages) - real dishes + prices.
4. `fetch_food_coupons` - real offers.
5. generates several **formations** (budget-fitting combos): CRAVING MATCH,
   BIG MAINS, MAX VARIETY, and more. You pick one.

### Ordering (2-step, explicit)

Discovery never orders anything. When you pick a formation and hit EXECUTE:

1. **Stage** - `update_food_cart` adds the combo to your real cart, then
   `get_food_cart` returns the real bill (items + delivery + taxes). Shown in a
   confirm dialog.
2. **Place** - only if you click PLACE REAL ORDER: `place_food_order`
   (payment `Cash` / COD). CANCEL runs `flush_food_cart` so nothing lingers.

So a real order needs two deliberate clicks and shows the real bill first.
Instamart generates baskets but ordering is not wired yet.

## Architecture

```
public/index.html   single-file UI (HUD, radar canvas, particles). No framework.
server.mjs          static server + OAuth flow + SSE + /api/tools. No deps.
src/oauth-provider.mjs   file-backed OAuth 2.1 + PKCE provider (.swiggy/*.json)
src/agent.mjs       real LIVE agent over the MCP
src/login.mjs       CLI login (alternative to the in-app button)
src/list-tools.mjs  dump live schemas to schema.<server>.json
src/order-demo.mjs  adaptive search demo (stops before ordering)
```

## Deploy

The UI is a static folder, so the **DEMO** deploys anywhere. LIVE needs the Node
backend and your own token, so keep LIVE local (do not host your tokens).

- **GitHub Pages**: pushing to `main` runs `.github/workflows/pages.yml`, which
  publishes `public/` to `https://atishyy27.github.io/swiggy-mcp-toy/`.
- **Any static host** (Vercel / Netlify): point it at `public/`.

On a static deploy the LIVE controls detect the missing backend and show a
"clone for LIVE" hint instead of erroring.

## Notes / gotchas

- `localhost:3000` OAuth callback must be reachable; the redirect uses whatever
  `PORT` the server started on. `localhost` is whitelisted by Swiggy.
- Token expires in ~5 days - just click CONNECT again.
- Delete `.swiggy/` to force a fresh login. Tokens are gitignored.
- Dineout table booking exists but is not wired into the agent yet.
