# swiggy-mcp-toy // FEASTMODE

A deal oracle built on **Swiggy's official MCP servers**. You give it a craving and
a cap. It answers one question: *where is money being left on the table right now?*

Every claim it makes shows the arithmetic that produced it, so you can check it
with a calculator. That is deliberate. A tool that says "great deal!" is worthless;
a tool that says `Rs 20 / 40g = Rs 0.500 vs Rs 0.345, +45%` can be proven wrong.

Not affiliated with Swiggy. Free to prototype on `localhost`; production and real
transactions are gated by Swiggy (India-only, invite-led).

```bash
npm install
npm run ui      # http://localhost:3000  -> CONNECT SWIGGY
```

---

## The one thing worth knowing

Swiggy sells the same Lay's Classic Salted at **Rs 20 for 58g** and **Rs 20 for
40g**. Same price. Same shelf. One bag is 45% more chips.

```
Lay's (Classic Salted) Crunchy Potato Chips
   58 g   Rs 20   Rs 0.345/g   <- buy this
   40 g   Rs 20   Rs 0.500/g   +45% per gram
```

Nobody divides fifty prices by fifty pack weights in their head. A computer does it
in one round trip. That is the entire edge, and it is the thing this repo exists to
demonstrate.

---

## The three MCP servers, and how they differ

| Vertical  | Endpoint                         | Tools | Speaks   | Discounts are |
|-----------|----------------------------------|-------|----------|---------------|
| Food      | `https://mcp.swiggy.com/food`     | 18    | markdown | cart-bound, must be probed |
| Instamart | `https://mcp.swiggy.com/im`       | 14    | **JSON** | published up front |
| Dineout   | `https://mcp.swiggy.com/dineout`  | 8     | ?        | not yet explored |

Shared auth server at `https://mcp.swiggy.com/auth`. OAuth 2.1 + PKCE (S256),
dynamic client registration, public client (`token_endpoint_auth_method: none`),
scopes `mcp:tools mcp:resources mcp:prompts`, roughly a 5-day token, refresh
supported. One token per vertical, so you log in to each separately.

**That "Speaks" column is the whole architecture.** Food replies in em-dash
markdown that you regex. Instamart replies in structured JSON. Feeding one to the
other's parser matches nothing and returns zero results with no error, which is
exactly the bug that made Instamart look broken for weeks.

Dump the real schemas yourself:

```bash
node src/list-tools.mjs all      # writes schema.<server>.json
```

---

## Two different games, because the servers are different

### Instamart: arithmetic (instant, parallel)

`search_products` hands back `mrp` and `offerPrice` **for every pack size**, in
JSON, with no cart required. So there is nothing to probe. Divide price by weight
and the answer falls out. Three things it looks for:

- **Same price, more product.** Two packs, identical rupees, one is bigger. No
  trade-off to weigh, one is simply strictly worse.
- **Wrong pack size.** `Rs 176 / 100g` vs `Rs 312 / 200g` is a 13% premium per gram
  for the privilege of buying less.
- **Cheapest per gram, any brand.** Search "oreo" and the cheapest biscuit per gram
  is usually *not* an Oreo.

Because there is no cart in the loop, every component of a craving is searched in
parallel. `chips + oreo` is two concurrent calls and finishes in about a second.

### Food: search with an expensive, serial oracle

Food discounts **cannot be precomputed**. `fetch_food_coupons` returns nothing until
a cart exists, and eligibility is decided server-side, per cart, per item. So the
only way to learn what a cart really costs is to stage it and ask.

And **Swiggy gives your account exactly one cart.** `update_food_cart` overwrites it.
So the oracle is strictly serial (about 5s per probe) and cannot be parallelised, no
matter how many workers you throw at it. The entire skill is therefore *choosing
which probes to spend*, not running more of them.

---

## What we had to reverse-engineer

All of this is undocumented, all of it verified live, and every one of them was
silently breaking the agent.

1. **`search_restaurants` only understands cuisines and restaurant names.** Give it a
   dish or a vague phrase (`veg thali`, `lunch`, `snacks`) and it does not error. It
   quietly returns *dish* rows with no rating, no ETA, and menu-item ids where
   restaurant ids should be. That is why a real Bengaluru hunt showed zero
   restaurants. Fix: map the craving onto a cuisine (`thali` -> `north indian`) and
   keep `restaurant` as a net that always catches.

2. **Coupons are cart-bound.** Zero coupons until a cart exists. Eight the moment a
   Rs 149 item is staged.

3. **The coupon code is the display name, not the UUID.** `apply_food_coupon`
   wants `FLAT135`, not the uuid in the `code:` field.

4. **A coupon row says one of two opposite things.** `Save Rs 200 on this order!` is
   a DISCOUNT. `Add Rs 159 more to avail this offer` is a SHORTFALL against your
   *current* cart, not a fixed minimum. Reading the first rupee figure out of either
   sentence, as we did for a while, means reading a discount as a threshold.

5. **Swiggy refuses a coupon on any cart holding an already-discounted dish.**
   Categories like `## 99 Store`, `## McSaver`, `## Items starting at 99` are the
   cheapest items on the menu, so padding a cart with them raises the total *and*
   blocks the coupon you raised it for. Self-defeating in both directions.

6. **Menu category headers are the best classification signal.** `## Fries & Sides`
   tells you more about a dish than any amount of guessing from its name.

7. **Egg is tagged `Non-veg`.** So pure-veg filtering works off the tag, not the name.

8. **Prices can be decimal** (`Rs 42.85`). A regex expecting integers drops the row
   silently, with no error. A non-matching regex is a liar: count what you skipped.

9. **Instamart's `update_cart` REPLACES the whole cart.** Call it naively and you
   have just destroyed whatever the user had in there. We read the cart first and
   merge into it.

---

## Knowing when NOT to probe

The interesting part of the Food agent is what it refuses to do.

Crossing a coupon threshold can be worth more than the food it costs to cross it,
so the cheapest way to buy one sandwich is sometimes to buy two sandwiches. But a
top-up is dead on arrival in two ways, and both can be ruled out with arithmetic
*before* spending a single 5-second probe:

- **It cannot pay for itself.** Rs 398 of food to unlock Rs 200 off is a loss with a
  discount stapled to it.
- **It cannot land under the cap.** A Rs 550-off coupon on a Rs 563 cart is a fine
  deal in the abstract and completely useless to someone who came here to pay Rs 150.

The cap is the whole point. A saving you cannot afford is not a saving. So a veg
sandwich hunt at a Rs 150 cap now says exactly this, and stops:

```
skip top-up // even with Rs 550 off, a Rs 635 cart still bills about
             Rs 199, over your Rs 150 cap.
```

That is an honest "no deal exists here", delivered in 34 seconds instead of ground
out over 48. Refusing to probe is the skill.

---

## Your cart is your real cart

This is the bit that surprises people. `update_food_cart` and `update_cart` write to
your **actual Swiggy cart**. Not a sandbox. So the intended flow is:

1. FEASTMODE stages the winning cart.
2. You open the Swiggy app, and it is already there.
3. You pay in the app, like normal.

You never have to trust this code with your money. Placing an order from here is a
separate, deliberate second click (`place_food_order`, COD), and CANCEL runs
`flush_food_cart` so nothing lingers.

---

## Running it

```bash
npm install
npm run ui                    # http://localhost:3000

node src/login.mjs food       # or log in per vertical from the CLI
node src/login.mjs instamart
node src/login.mjs dineout

node src/list-tools.mjs all   # dump live tool schemas
```

Tokens land in `.swiggy/<server>.json`, which is gitignored. Delete it to force a
fresh login. They last about 5 days.

## Architecture

```
public/index.html        single-file UI. No framework, no build step.
server.mjs               static server + OAuth + SSE. No deps.
src/agent.mjs            the Food agent: search, build, probe, gate.
src/instamart.mjs        the Instamart oracle: parse, divide, rank.
src/oauth-provider.mjs   OAuth 2.1 + PKCE provider
src/login.mjs            CLI login
src/list-tools.mjs       schema dumper
```

## Deploy

The public deploy runs the real server so visitors connect their **own** Swiggy
account. Two things make that safe:

- **Tokens are session-scoped**, never shared between visitors and never written to
  disk.
- **Ordering is hard-disabled in public mode** (`FEASTMODE_PUBLIC=1`). Staging is
  allowed, because it only touches the visitor's own cart and is reversible.
  `place_food_order` returns 403 before it can reach the MCP. No money can move.

Run the real thing locally if you want to actually order.

Swiggy's dynamic client registration accepts a non-localhost `https` redirect URI
(`POST /auth/register` returns 201 and echoes it back), so the hosted OAuth flow
should work. The final say happens at `/authorize`, which we can only exercise by
deploying, so treat this as "very likely" rather than proven.

## Honest limits

- **"Spend more, pay less" is real but rare.** It needs the coupon to beat the
  padding *plus* tax. It is implemented and detected, but it did not fire in either
  live test at a Rs 150 cap, and the README will not pretend otherwise.
- A full Food hunt takes 30-60 seconds, because the oracle is serial and there is no
  way around that.
- The Instamart catalog is genuinely live. Run the same query twice and the variant
  count moves, because items go in and out of stock under you.
- Dineout ranks venues by a Pareto frontier (rating vs cost), not a single "best" pick —
  there's no unit-price arbitrage to find in a restaurant booking the way there is in a
  packaged good.
- `oreo shake` currently relaxes to `shake` if the exact phrase misses, and does not
  yet tell you it did.
