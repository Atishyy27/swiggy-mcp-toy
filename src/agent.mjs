// LIVE Swiggy MCP agent.
//
// Flow: address -> search restaurants -> pull MANY real menus in parallel ->
// build every budget-fitting FORMATION across ALL of those kitchens -> you pick
// one -> we stage it in your real cart, hunt real coupons against that real
// cart, and show the real bill before anything is placed.
//
// Ordering stays a 2-step, explicit flow (stage -> place). Discovery never buys.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { FileOAuthProvider, SERVERS } from "./oauth-provider.mjs";

const textOf = (r) => (r?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Swiggy separates fields with an em dash. Matched by escape so this file stays
// free of literal em dashes.
const D = "\\u2014";

const parseAddresses = (t) => {
  const out = [], re = /(\d+)\.\s*(?:\[([^\]]*)\]\s*)?([^:]+):\s*(.+?)\s*\(ID:\s*(\w+)\)/g;
  let m; while ((m = re.exec(t))) out.push({ tag: (m[2] || "").trim(), name: m[3].trim(), addr: m[4].trim(), id: m[5] });
  return out;
};

// Restaurant rows look like:
//   1. Meghana Foods (Ad) <dash> Biryani, Andhra | 4.6* | 42 min | Rs 500 for two (ID: 271)
// But for vague or dish-like queries Swiggy degrades to DISH rows instead:
//   1. Veg Thali <dash>  | undefined* | ? min |  (ID: 98607940)
// Those carry menu-item ids, not restaurant ids, so they are useless to us. We
// keep only rows that carry a real rating, and treat "all rows degraded" as a
// miss so the caller can retry with a better query.
function parseRestaurants(t) {
  const re = new RegExp(
    "(\\d+)\\.\\s*([\\s\\S]+?)\\s*(?:\\(Ad\\)\\s*)?" + D +
    "\\s*([^|]*)\\|\\s*([\\d.]+|undefined)\\u2605\\s*\\|\\s*(\\d+|\\?)\\s*min\\s*\\|\\s*(?:\\u20b9(\\d+)\\s*for two)?\\s*\\(ID:\\s*(\\d+)\\)",
    "g"
  );
  const rows = [];
  let m;
  while ((m = re.exec(t))) {
    const rating = parseFloat(m[4]);
    rows.push({
      name: m[2].replace(/\s+/g, " ").trim(),
      cuisines: m[3].replace(/\s+/g, " ").trim(),
      rating: Number.isFinite(rating) ? rating : 0,
      eta: m[5] === "?" ? 0 : +m[5],
      for2: m[6] ? +m[6] : 0,
      id: m[7],
      real: Number.isFinite(rating),
    });
  }
  return rows.filter((r) => r.real);
}

// Menu rows. Prices can be decimal (Rs 42.85), which the old parser dropped.
// We also track the "## Category" header each item sits under: that header is
// the single best signal for what a dish IS. "## Fries & Sides" tells you more
// than any amount of guessing from the name.
function parseItems(t) {
  const row = new RegExp(
    "^\\s*-\\s*(.+?)\\s*" + D + "\\s*\\u20b9([\\d.]+)\\s*\\|\\s*([^\\[\\n(]*)"
  );
  const out = [];
  let cat = "";
  for (const line of t.split("\n")) {
    const h = line.match(/^#+\s*(.+?)\s*$/);
    if (h) { cat = h[1]; continue; }
    const m = line.match(row);
    if (!m) continue;
    const id = line.match(/\(ID:\s*(\d+)\)/);
    if (!id) continue;
    out.push({
      name: m[1].trim(), price: Math.round(parseFloat(m[2])),
      tags: m[3].trim(), cat, id: id[1],
    });
  }
  return out;
}

// What IS this dish? Order matters: a "Chicken Nugget" is a SIDE, even though
// the word "chicken" also appears in the MAIN pattern.
const KIND = [
  ["condiment", /sachet|\bdips?\b|sauce|mayo|ketchup|seasoning|spice mix|cutlery|add[- ]?on|extra (cheese|slice)/i],
  ["dessert", /dessert|ice ?cream|sundae|mcflurry|brownie|cake|gelato|pastry|donut|jamun|halwa|kulfi/i],
  ["drink", /beverage|drink|coke|pepsi|sprite|thums|fanta|mirinda|shake|smoothie|juice|coffee|latte|\btea\b|lassi|water|soda|mojito|cola|zero/i],
  ["side", /fries|\bsides?\b|nugget|wings?|onion ring|popcorn|garlic bread|salad|soup|starter|snack|chaap sticks/i],
  ["main", /burger|wrap|roll|biry|pizza|combo|meal|rice|bowl|thali|sandwich|pasta|noodle|curry|chicken|paneer|dosa|steak|platter|bucket|kebab|tikka|momo|puff|whopper/i],
];
function classify(it) {
  const s = (it.name + " " + it.cat).toLowerCase();
  for (const [kind, re] of KIND) if (re.test(s)) return kind;
  return "side";
}

// Dishes that are ALREADY on offer. Swiggy will not stack a coupon on top of
// these, so a cart holding one gets the coupon refused. The menu never flags
// them, but the category header gives them away every time.
const OFFER_CAT = /99 store|mcsaver|saver|starting at|value (deal|meal|combo)|offer|deal of|super saver/i;
const isOfferItem = (i) => OFFER_CAT.test(i.cat || "");

const parseCoupons = (t) => {
  const re = new RegExp("-\\s*([A-Z0-9]+)\\s*\\[([^\\]]*)\\]\\s*" + D + "\\s*(.+?)\\s*\\(code:", "g");
  const out = [];
  let m;
  while ((m = re.exec(t))) {
    const desc = m[3].trim();
    out.push({
      code: m[1],
      desc,
      blocked: /NOT APPLICABLE/i.test(m[2]),
      // "Add Rs 449 more to avail this offer" is really the minimum order value.
      minOrder: +((desc.match(/₹(\d+)/) || [])[1] || 0),
    });
  }
  return out;
};

// Bill lines from get_food_cart / update_food_cart.
const parseBill = (t) => {
  const n = (re) => { const m = t.match(re); return m ? Math.round(parseFloat(m[1])) : 0; };
  return {
    itemTotal: n(/Item total:\s*₹([\d.]+)/i),
    delivery: /Delivery:\s*FREE/i.test(t) ? 0 : n(/Delivery:\s*₹([\d.]+)/i),
    freeDelivery: /Delivery:\s*FREE/i.test(t),
    taxes: n(/Taxes[^:]*:\s*₹([\d.]+)/i),
    discount: n(/(?:Discount|Coupon|Savings)[^:]*:\s*-?\s*₹([\d.]+)/i),
    toPay: n(/TO PAY:\s*₹([\d.]+)/i),
  };
};

const isNonVeg = (t = "") => /non[-\s]?veg/i.test(t);
const isVeg = (t = "") => /veg/i.test(t) && !isNonVeg(t);

const STOP = new Set(["something", "nice", "good", "tasty", "some", "food", "want", "give", "get", "the", "and", "for", "with", "please", "order", "under", "cheap", "best", "me", "my"]);

// How many kitchens we stage-and-price for real. Each kitchen costs two probes
// (a base meal, then a cart built to clear its cheapest coupon threshold) and a
// probe is 4 to 9 MCP calls. This is the dial between honesty and wall-clock.
const PROBE_KITCHENS = 5;

// How many times we may top a cart up chasing a coupon threshold before giving
// up on that kitchen.
const TOPUP_ROUNDS = 2;

function emojiFor(s = "") {
  s = s.toLowerCase();
  if (/biry|pulao/.test(s)) return "\u{1F35B}";
  if (/pizza/.test(s)) return "\u{1F355}";
  if (/burger/.test(s)) return "\u{1F354}";
  if (/noodle|ramen|chinese|hakka|manch/.test(s)) return "\u{1F35C}";
  if (/roll|shawarma|wrap|frankie/.test(s)) return "\u{1F32F}";
  if (/chicken|kebab|tandoor|tikka|wing/.test(s)) return "\u{1F357}";
  if (/cake|choc|dessert|sweet|ice|gelato|brownie/.test(s)) return "\u{1F370}";
  if (/coffee|tea|shake|juice|lemon|cola|beverage|lassi/.test(s)) return "\u{1F964}";
  if (/egg/.test(s)) return "\u{1F95A}";
  if (/naan|roti|bread|kulcha|paratha/.test(s)) return "\u{1FAD3}";
  if (/dosa|idli|vada|uttapam/.test(s)) return "\u{1F95E}";
  if (/paneer|dal|aloo|salad|thali|veg/.test(s)) return "\u{1F957}";
  if (/rice|curry/.test(s)) return "\u{1F35B}";
  return "\u{1F37D}️";
}

// Build MEALS, not piles. A meal must contain at least one MAIN. Condiments are
// banned outright: a formation of four dips and two cokes is not dinner.
//
// payCap is what you are willing to PAY, after coupons and taxes. We cannot know
// the discount until we stage a real cart (Swiggy decides eligibility per item,
// server-side), so at build time we cast a wide net on item total and let the
// verification pass below throw away whatever does not really land under the cap.
function buildMeals(items, query, payCap, veg, rest) {
  let pool = items.filter((i) => i.price > 0);
  if (veg) pool = pool.filter((i) => isVeg(i.tags));
  pool = pool.map((i) => ({ ...i, kind: classify(i) })).filter((i) => i.kind !== "condiment");

  const mains = pool.filter((i) => i.kind === "main");
  if (!mains.length) return [];
  const sides = pool.filter((i) => i.kind === "side");
  const drinks = pool.filter((i) => i.kind === "drink");

  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
  const craving = (it) => words.some((w) => (it.name + " " + it.cat).toLowerCase().includes(w));
  const star = (it) => /bestseller/i.test(it.tags);
  // An already-discounted dish is cheap, but it makes the whole cart
  // coupon-ineligible. A coupon is usually worth more than the item discount, so
  // lean away from them when there is a real alternative.
  const score = (it) => (craving(it) ? 4 : 0) + (star(it) ? 2 : 0) - (isOfferItem(it) ? 3 : 0);

  const cheapest = (arr, cap) => arr.filter((i) => i.price <= cap && !isOfferItem(i)).sort((a, b) => a.price - b.price)[0]
    || arr.filter((i) => i.price <= cap).sort((a, b) => a.price - b.price)[0];

  // Coupons need the item total to clear a threshold, and taxes add ~18% on top,
  // so the item total that lands on a given pay-cap varies a lot. Probe a spread.
  const targets = [0.85, 1.15, 1.5, 1.9, 2.3].map((k) => Math.round(payCap * k));
  const out = [], seen = new Set();

  for (const target of targets) {
    const affordable = mains.filter((m) => m.price <= target);
    if (!affordable.length) continue;

    // Best main we can justify at this target: prefer craving and bestsellers,
    // then the most substantial one that still leaves room.
    const main = [...affordable].sort((a, b) => (score(b) - score(a)) || (b.price - a.price))[0];
    const picked = [main];
    let total = main.price;

    const side = cheapest(sides, target - total);
    if (side) { picked.push(side); total += side.price; }
    const drink = cheapest(drinks, target - total);
    if (drink) { picked.push(drink); total += drink.price; }

    // Still lots of headroom and no second main yet? Make it a proper feast.
    const second = mains.filter((m) => m.id !== main.id && m.price <= target - total)
      .sort((a, b) => (score(b) - score(a)) || (b.price - a.price))[0];
    if (second && total + second.price <= target && total < target * 0.6) {
      picked.push(second); total += second.price;
    }

    const key = picked.map((i) => i.id).sort().join(",");
    if (seen.has(key)) continue;
    seen.add(key);

    const kinds = picked.map((i) => i.kind);
    const label =
      kinds.filter((k) => k === "main").length > 1 ? "DOUBLE MAIN"
      : kinds.includes("side") && kinds.includes("drink") ? "FULL MEAL"
      : kinds.includes("side") || kinds.includes("drink") ? "MAIN + SIDE"
      : "SOLO MAIN";

    out.push({
      label,
      hero: craving(main) ? "CRAVING" : star(main) ? "BESTSELLER" : "",
      itemTotal: total,
      restaurant: { id: rest.id, name: rest.name, rating: rest.rating, eta: rest.eta },
      items: picked.map((i) => ({
        name: i.name, price: i.price, kind: i.kind,
        emoji: emojiFor(i.name + " " + i.cat), menu_item_id: i.id,
        quantity: 1, veg: isVeg(i.tags),
      })),
    });
  }
  return out;
}

// Put a meal in the REAL cart, hunt REAL coupons against it, read the REAL bill.
// This is the only way to know the true price: eligibility is server-side and
// per-item (a coupon will refuse a dish that is already discounted, which is why
// a big cart can still get turned down). Leaves the cart flushed.
async function priceMeal(call, addressId, meal) {
  try { await call("flush_food_cart", {}); } catch {}
  await call("update_food_cart", {
    restaurantId: String(meal.restaurant.id), addressId,
    cartItems: meal.items.map((i) => ({ menu_item_id: String(i.menu_item_id), quantity: i.quantity || 1 })),
  });
  let cart = textOf(await call("get_food_cart", { addressId }));
  let bill = parseBill(cart);
  const basePay = bill.toPay;

  let offers = [];
  try { offers = parseCoupons(textOf(await call("fetch_food_coupons", { addressId, restaurantId: String(meal.restaurant.id) }))); } catch {}

  let applied = null;
  for (const o of offers.slice(0, 4)) {
    try {
      await call("apply_food_coupon", { couponCode: o.code, addressId });
      const t = textOf(await call("get_food_cart", { addressId }));
      const b = parseBill(t);
      if (b.toPay && b.toPay < basePay) {
        applied = { code: o.code, saved: basePay - b.toPay };
        bill = b; cart = t;
        break;
      }
    } catch { /* Swiggy refused it, usually because an item is already discounted */ }
  }
  return { bill, basePay, applied, offers, cart: cart.split("Cart widget")[0].trim().slice(0, 1200) };
}

// Hunt the cheapest REAL price at one kitchen.
//
// This is the manoeuvre Atishay does by hand: a Rs 179 cart with Rs 117 off beats
// a Rs 120 cart with nothing. But Swiggy never tells you the threshold straight
// out. It only ever says "add Rs N more", relative to the cart you already have.
// So we close the loop: stage a cart, read what is still missing, top it up with
// the cheapest real food, and ask again. Up to TOPUP_ROUNDS times.
//
// Every number this returns came off a real bill. Leaves the cart staged; the
// caller flushes.
async function huntBestPrice(call, addressId, meal, menuItems, veg, emit) {
  const rid = String(meal.restaurant.id);
  const inCart = meal.items.map((i) => ({ ...i }));

  const stage = async () => {
    await call("update_food_cart", {
      restaurantId: rid, addressId,
      cartItems: inCart.map((i) => ({ menu_item_id: String(i.menu_item_id), quantity: i.quantity || 1 })),
    });
    const t = textOf(await call("get_food_cart", { addressId }));
    return { text: t, bill: parseBill(t) };
  };

  // What we bolt on to climb toward a threshold.
  //
  // Two traps here, both learned the hard way:
  //  1. No condiments. Padding with Rs 1 ketchup sachets is how we got carts made
  //     of four dips and two cokes.
  //  2. No already-discounted items. Swiggy refuses a coupon outright if the cart
  //     holds a dish that is itself on offer, and the cheapest items on any menu
  //     are exactly those ("## 99 Store", "## McSaver", "## Items starting at 99").
  //     Padding with them is self-defeating: it raises the total AND blocks the
  //     coupon you raised it for.
  const pad = menuItems
    .filter((i) => i.price > 0)
    .filter((i) => (veg ? isVeg(i.tags) : true))
    .map((i) => ({ ...i, kind: classify(i) }))
    .filter((i) => i.kind !== "condiment" && i.price >= 40 && !isOfferItem(i))
    .sort((a, b) => a.price - b.price);

  try { await call("flush_food_cart", {}); } catch {}
  let cur = await stage();
  let best = { bill: cur.bill, basePay: cur.bill.toPay, applied: null, cart: cur.text, items: [...inCart] };

  for (let round = 0; round <= TOPUP_ROUNDS; round++) {
    const basePay = cur.bill.toPay;

    let offers = [];
    try { offers = parseCoupons(textOf(await call("fetch_food_coupons", { addressId, restaurantId: rid }))); } catch {}

    // Try to actually land one. Swiggy refuses coupons on already-discounted
    // items, so "returned 200" proves nothing: only the bill moving proves it.
    for (const o of offers.slice(0, 4)) {
      try {
        await call("apply_food_coupon", { couponCode: o.code, addressId });
        const t = textOf(await call("get_food_cart", { addressId }));
        const b = parseBill(t);
        if (b.toPay && b.toPay < basePay) {
          const hit = { bill: b, basePay, applied: { code: o.code, saved: basePay - b.toPay }, cart: t, items: [...inCart] };
          if (hit.bill.toPay < best.bill.toPay) best = hit;
          return best;
        }
      } catch { /* not eligible on these items */ }
    }
    if (cur.bill.toPay < best.bill.toPay) best = { bill: cur.bill, basePay, applied: null, cart: cur.text, items: [...inCart] };
    if (round === TOPUP_ROUNDS) break;

    // Nothing applied. What is the nearest offer still asking for, right now?
    const need = offers.filter((o) => o.minOrder > 0).sort((a, b) => a.minOrder - b.minOrder)[0];
    if (!need) break;

    // Overshoot: Swiggy quietly marks some dishes down after we stage them, so a
    // cart built to land exactly on the threshold lands just under it instead.
    const goal = Math.round(need.minOrder * 1.15) + 20;
    const add = [];
    let got = 0;
    for (const p of pad) {
      if (got >= goal) break;
      if (inCart.some((c) => c.menu_item_id === p.id) || add.some((c) => c.id === p.id)) continue;
      add.push(p);
      got += p.price;
    }
    if (!add.length || got < need.minOrder) break;

    emit({ type: "log", msg: `    ${need.code} wants Rs ${need.minOrder} more // adding ${add.length} item(s) (Rs ${got})`, cls: "sys" });
    for (const p of add) {
      inCart.push({
        name: p.name, price: p.price, kind: p.kind, emoji: emojiFor(p.name + " " + p.cat),
        menu_item_id: p.id, quantity: 1, veg: isVeg(p.tags),
      });
    }
    await sleep(300);
    cur = await stage();
  }
  return best;
}

// Price one cart, no coupon chasing. Used for the VALUE PICK: the kitchen's own
// already-discounted dish. It can never take a coupon, but it does not need one.
// Rs 158 with no coupon beats Rs 202 with one, and only the real bill can say
// which way it falls.
async function priceCart(call, addressId, rid, items) {
  try { await call("flush_food_cart", {}); } catch {}
  await call("update_food_cart", {
    restaurantId: String(rid), addressId,
    cartItems: items.map((i) => ({ menu_item_id: String(i.menu_item_id), quantity: 1 })),
  });
  const t = textOf(await call("get_food_cart", { addressId }));
  return { bill: parseBill(t), cart: t.split("Cart widget")[0].trim().slice(0, 1200) };
}

// Build a meal that DELIBERATELY clears a coupon threshold.
//
// This is the move Atishay makes by hand: a Rs 179 minimum with Rs 79 off beats
// a Rs 120 cart with no coupon. A naive "stay cheap" filler never discovers it,
// because it never lets the item total climb far enough to unlock anything.
// Overshoot the threshold by as little as possible, and keep it a real meal.
function buildMealClearing(items, query, threshold, veg, rest) {
  let pool = items.filter((i) => i.price > 0);
  if (veg) pool = pool.filter((i) => isVeg(i.tags));
  pool = pool.map((i) => ({ ...i, kind: classify(i) })).filter((i) => i.kind !== "condiment");

  const mains = pool.filter((i) => i.kind === "main");
  if (!mains.length) return null;
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
  const craving = (it) => words.some((w) => (it.name + " " + it.cat).toLowerCase().includes(w));

  // Start from the best main, then top up with the cheapest real items until the
  // item total clears the threshold. Cheapest top-ups keep the overshoot small.
  const main = [...mains].sort((a, b) => (craving(b) - craving(a)) || (/bestseller/i.test(b.tags) - /bestseller/i.test(a.tags)) || a.price - b.price)[0];
  const picked = [main];
  let total = main.price;

  const fillers = pool
    .filter((i) => i.id !== main.id && i.kind !== "dessert")
    .sort((a, b) => a.price - b.price);

  for (const f of fillers) {
    if (total >= threshold) break;
    if (picked.length >= 5) break;
    if (picked.some((p) => p.id === f.id)) continue;
    picked.push(f);
    total += f.price;
  }
  if (total < threshold) return null; // this kitchen cannot reach the offer

  return {
    label: "OFFER UNLOCK",
    hero: "UNLOCK",
    itemTotal: total,
    restaurant: { id: rest.id, name: rest.name, rating: rest.rating, eta: rest.eta },
    items: picked.map((i) => ({
      name: i.name, price: i.price, kind: i.kind,
      emoji: emojiFor(i.name + " " + i.cat), menu_item_id: i.id,
      quantity: 1, veg: isVeg(i.tags),
    })),
  };
}

function newClient(server) {
  const provider = new FileOAuthProvider(server);
  const transport = new StreamableHTTPClientTransport(new URL(SERVERS[server]), { authProvider: provider });
  const client = new Client({ name: "feastmode-agent", version: "0.2.0" }, { capabilities: {} });
  return { provider, transport, client };
}
async function withClient(server, fn) {
  const { provider, transport, client } = newClient(server);
  if (!provider.tokens()) throw new Error(`not connected (${server})`);
  await client.connect(transport);
  try { return await fn(client); } finally { await client.close(); }
}

export async function listAddresses({ server = "food" }) {
  return withClient(server, async (c) =>
    parseAddresses(textOf(await c.callTool({ name: "get_addresses", arguments: { page: 1, pageSize: 10 } }))));
}

// Stage the picked formation in the REAL cart, then hunt REAL coupons against
// that REAL cart and keep whichever one actually lowers the bill. Fully
// reversible via cancelOrder(). Nothing is placed here.
export async function stageOrder({ server = "food", addressId, restaurantId, items }) {
  return withClient(server, async (c) => {
    const call = (name, args) => c.callTool({ name, arguments: args });

    try { await call("flush_food_cart", {}); } catch {}
    const cartItems = items.map((i) => ({ menu_item_id: String(i.menu_item_id || i.id), quantity: i.quantity || 1 }));
    await call("update_food_cart", { restaurantId: String(restaurantId), addressId, cartItems });

    let cartText = textOf(await call("get_food_cart", { addressId }));
    let bill = parseBill(cartText);
    const basePay = bill.toPay;

    // Real coupons only exist once a cart exists.
    let offers = [];
    try { offers = parseCoupons(textOf(await call("fetch_food_coupons", { addressId, restaurantId: String(restaurantId) }))); } catch {}

    // Swiggy decides eligibility per cart and often refuses, so we just try the
    // plausible ones and keep the first that genuinely reduces TO PAY.
    let applied = null;
    const tried = [];
    const candidates = offers.filter((o) => !o.minOrder || o.minOrder <= bill.itemTotal).slice(0, 6);
    for (const o of candidates) {
      try {
        await call("apply_food_coupon", { couponCode: o.code, addressId });
        const t = textOf(await call("get_food_cart", { addressId }));
        const b = parseBill(t);
        if (b.toPay && b.toPay < basePay) {
          applied = { code: o.code, desc: o.desc, saved: basePay - b.toPay };
          cartText = t;
          bill = b;
          break;
        }
        tried.push({ code: o.code, why: "no change to bill" });
      } catch (e) {
        tried.push({ code: o.code, why: String(e?.message || e).split("\n")[0].slice(0, 80) });
      }
    }

    // Anything we could not use becomes an honest "unlock" hint.
    const locked = offers
      .filter((o) => !applied || o.code !== applied.code)
      .map((o) => ({ code: o.code, desc: o.desc, need: Math.max(0, o.minOrder - bill.itemTotal) }))
      .sort((a, b) => a.need - b.need)
      .slice(0, 6);

    return { bill, basePay, applied, locked, tried, offersFound: offers.length, cart: cartText.split("Cart widget")[0].trim().slice(0, 1200) };
  });
}

export async function placeOrder({ server = "food", addressId, note }) {
  return withClient(server, async (c) => {
    const args = { addressId, paymentMethod: "Cash" };
    if (note) args.noteToRestaurant = note;
    return { result: textOf(await c.callTool({ name: "place_food_order", arguments: args })).slice(0, 1200) };
  });
}
export async function cancelOrder({ server = "food" }) {
  return withClient(server, async (c) => ({ result: textOf(await c.callTool({ name: "flush_food_cart", arguments: {} })).slice(0, 400) }));
}

// search_restaurants only answers CUISINE or restaurant-name queries. Give it a
// dish or a vague phrase ("veg thali", "lunch", "something nice") and it quietly
// returns dish rows with no rating, no eta and menu-item ids, which are useless
// for ordering. That is the bug that made a Bengaluru hunt show zero kitchens.
// So: map the craving onto a cuisine, and keep "restaurant" as the net that
// always catches. The original words still drive dish ranking inside the menus.
const CUISINE = [
  [/biry|pulao|dum/, "biryani"],
  [/pizza|pasta|garlic bread/, "pizza"],
  [/burger|fries|nugget/, "burger"],
  [/noodle|manchurian|hakka|momo|fried rice|schezwan/, "chinese"],
  [/dosa|idli|vada|sambar|uttapam|filter coffee|meduA?/, "south indian"],
  [/thali|paneer|dal|roti|naan|kulcha|curry|tikka|butter|chole|rajma|sabzi/, "north indian"],
  [/kebab|shawarma|roll|tandoor|mughlai/, "mughlai"],
  [/cake|dessert|ice cream|brownie|sweet|gelato/, "desserts"],
  [/sandwich|sub|wrap/, "sandwich"],
  [/coffee|tea|shake|juice|smoothie/, "beverages"],
  [/salad|healthy|bowl|keto|protein/, "healthy"],
  [/veg|vegetarian/, "north indian"],
];

async function findRestaurants(call, addrId, query, emit) {
  const q0 = query.toLowerCase();
  const words = q0.split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
  const cuisines = CUISINE.filter(([re]) => re.test(q0)).map(([, c]) => c);

  const tries = [query, ...words, ...cuisines, "restaurant"].filter((v, i, a) => v && a.indexOf(v) === i);
  for (const q of tries) {
    const rests = parseRestaurants(textOf(await call("search_restaurants", { addressId: addrId, query: q })));
    if (rests.length) {
      if (q !== query) emit({ type: "log", msg: `"${query}" is a dish, not a cuisine // re-aimed at <span class="k">${q}</span>`, cls: "fire" });
      return { rests, used: q };
    }
  }
  return { rests: [], used: query };
}

export async function runLiveMission({ server = "food", query, budget = 800, addressId, veg = 0, emit }) {
  const { provider, transport, client } = newClient(server);
  if (!provider.tokens()) { emit({ type: "error", msg: `not connected // CONNECT SWIGGY (${server})` }); return false; }
  try {
    await client.connect(transport);
  } catch (e) {
    emit({ type: "error", msg: e instanceof UnauthorizedError ? "session expired // reconnect" : "connect failed // " + (e?.message || e) });
    return false;
  }
  const call = (name, args) => { emit({ type: "call" }); return client.callTool({ name, arguments: args }); };
  emit({ type: "log", msg: `LIVE // connected to Swiggy ${server.toUpperCase()} MCP`, cls: "win" });

  try {
    emit({ type: "tool", name: "search", state: "run" });
    emit({ type: "log", msg: 'call <span class="k">get_addresses</span>()' });
    const addrs = parseAddresses(textOf(await call("get_addresses", { page: 1, pageSize: 10 })));
    if (!addrs.length) { emit({ type: "log", msg: "no saved address // add one in the Swiggy app", cls: "fire" }); emit({ type: "done" }); await client.close(); return true; }
    const addr = addrs.find((a) => a.id === addressId) || addrs[0];
    emit({ type: "log", msg: `delivering to <span class="k">[${addr.tag || "addr"}]</span> ${addr.addr.slice(0, 44)}`, cls: "hit" });

    if (server === "instamart") return await instamart(client, call, addr, query, budget, veg, emit);

    emit({ type: "log", msg: `call <span class="k">search_restaurants</span>("${query.slice(0, 24)}")${veg ? " // veg only" : ""}` });
    const { rests } = await findRestaurants(call, addr.id, query, emit);
    emit({ type: "tool", name: "search", state: "done" });
    if (!rests.length) {
      emit({ type: "log", msg: "Swiggy returned no kitchens for that // try a dish name", cls: "fire" });
      emit({ type: "done" }); await client.close(); return true;
    }
    for (const r of rests) {
      emit({ type: "kitchen", name: r.name });
      emit({ type: "log", msg: `  ${r.name} <span style="color:var(--dim)">${r.rating}★ ${r.eta}min ₹${r.for2}/2</span>`, cls: "sys" });
      await sleep(50);
    }
    emit({ type: "log", msg: `locked <span class="k">${rests.length}</span> real kitchens`, cls: "win" });

    // Raid every kitchen, not just the best-rated one.
    const targets = [...rests].sort((a, b) => (b.rating - a.rating) || (a.for2 - b.for2)).slice(0, 8);
    emit({ type: "tool", name: "menu", state: "run" });
    emit({ type: "log", msg: `pulling <span class="k">${targets.length}</span> real menus in parallel...` });

    const menus = await Promise.all(targets.map(async (r) => {
      let items = [];
      for (const page of [1, 2]) {
        try { items = items.concat(parseItems(textOf(await call("get_restaurant_menu", { addressId: addr.id, restaurantId: r.id, page })))); } catch {}
      }
      const byId = new Map(items.map((i) => [i.id, i]));
      items = [...byId.values()];
      const usable = veg ? items.filter((i) => isVeg(i.tags)) : items;
      emit({ type: "log", msg: `  ${r.name} <span class="k">${usable.length}</span> ${veg ? "veg " : ""}dishes`, cls: "sys" });
      return { rest: r, items: usable };
    }));
    emit({ type: "tool", name: "menu", state: "done" });

    const dishes = menus.reduce((n, m) => n + m.items.length, 0);
    emit({ type: "log", msg: `scanned <span class="k">${dishes}</span> real dishes across <span class="k">${menus.length}</span> kitchens`, cls: "win" });

    emit({ type: "tool", name: "cart", state: "run" });
    emit({ type: "log", msg: `building real meals // main + side + drink, no sachets`, cls: "" });
    let meals = menus.flatMap((m) => buildMeals(m.items, query, budget, veg, m.rest));

    const seen = new Set();
    meals = meals.filter((c) => {
      const k = c.restaurant.id + ":" + c.items.map((i) => i.menu_item_id).sort().join(",");
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });
    emit({ type: "tool", name: "cart", state: "done" });
    if (!meals.length) {
      emit({ type: "log", msg: `no real meal fits near Rs ${budget} // raise the cap`, cls: "fire" });
      emit({ type: "done" }); await client.close(); return true;
    }
    emit({ type: "log", msg: `built <span class="k">${meals.length}</span> candidate meals across <span class="k">${new Set(meals.map((c) => c.restaurant.id)).size}</span> kitchens`, cls: "win" });

    // ---- the honest part: price them for real ----
    // A coupon's value cannot be predicted, so we stage each candidate in the
    // real cart, hunt coupons against it, read the true TO PAY, and flush. Only
    // what genuinely lands under your pay cap survives.
    emit({ type: "tool", name: "deals", state: "run" });
    emit({ type: "log", msg: `PAY CAP Rs ${budget} // staging real carts to find the true price`, cls: "fire" });

    const priced = [];
    const menuOf = new Map(menus.map((m) => [m.rest.id, m]));
    const cheapestPerRest = new Map();
    for (const m of [...meals].sort((a, b) => a.itemTotal - b.itemTotal)) {
      if (!cheapestPerRest.has(m.restaurant.id)) cheapestPerRest.set(m.restaurant.id, m);
    }
    const round1 = [...cheapestPerRest.values()]
      .sort((a, b) => (b.hero ? 1 : 0) - (a.hero ? 1 : 0) || b.restaurant.rating - a.restaurant.rating)
      .slice(0, PROBE_KITCHENS);

    // Staging carts back to back makes Swiggy's endpoint throw transport errors.
    // Breathe between probes, and give a failed one a second chance before we
    // write the kitchen off.
    const priceWithRetry = async (m, menuItems) => {
      try { return await huntBestPrice(call, addr.id, m, menuItems, veg, emit); }
      catch (e) {
        if (!/Streamable HTTP|POSTing|fetch failed|socket/i.test(String(e?.message || e))) throw e;
        emit({ type: "log", msg: `  transport hiccup // retrying ${m.restaurant.name}`, cls: "sys" });
        await sleep(1500);
        return await huntBestPrice(call, addr.id, m, menuItems, veg, emit);
      }
    };

    // One hunt per kitchen: stage, chase the coupon threshold, keep the cheapest
    // real bill it can reach.
    for (let i = 0; i < round1.length; i++) {
      const m = round1[i];
      const menu = menuOf.get(m.restaurant.id);
      emit({ type: "verify", i: i + 1, n: round1.length, name: m.restaurant.name });
      emit({ type: "log", msg: `  staging real cart at <span class="k">${m.restaurant.name}</span>`, cls: "" });
      try {
        const r = await priceWithRetry(m, menu ? menu.items : []);
        const pay = r.bill.toPay || 0;
        if (!pay) continue;
        const under = pay <= budget;
        priced.push({
          ...m,
          items: r.items,
          itemTotal: r.bill.itemTotal || m.itemTotal,
          pay, basePay: r.basePay,
          coupon: r.applied ? r.applied.code : "", saved: r.applied ? r.applied.saved : 0,
          taxes: r.bill.taxes, delivery: r.bill.delivery, under,
        });
        if (r.applied) emit({ type: "deal", tag: r.applied.code, name: `${m.restaurant.name} // real`, gold: true, save: r.applied.saved });
        emit({
          type: "log",
          msg: `  ${under ? "<span class='k'>UNDER CAP</span>" : "over cap"} // ${m.restaurant.name} ` +
               (r.applied
                 ? `Rs ${r.basePay} -&gt; <span style="color:var(--gold)">Rs ${pay}</span> (${r.applied.code} saved Rs ${r.applied.saved})`
                 : `Rs ${pay} (no coupon eligible)`),
          cls: under ? "win" : "sys",
        });
      } catch (e) {
        emit({ type: "log", msg: `  hunt failed // ${m.restaurant.name} // ${String(e?.message || e).split("\n")[0].slice(0, 70)}`, cls: "sys" });
      }

      // VALUE PICK: this kitchen's own discounted dish. No coupon will ever stack
      // on it, but it is often the cheapest thing you can actually pay for.
      const deal = (menu ? menu.items : [])
        .map((i) => ({ ...i, kind: classify(i) }))
        .filter((i) => i.kind === "main" && isOfferItem(i) && i.price > 0 && i.price <= budget * 1.6 && (veg ? isVeg(i.tags) : true))
        .sort((a, b) => a.price - b.price)[0];
      if (deal) {
        try {
          await sleep(300);
          const one = [{ name: deal.name, price: deal.price, kind: "main", emoji: emojiFor(deal.name + " " + deal.cat), menu_item_id: deal.id, quantity: 1, veg: isVeg(deal.tags) }];
          const r = await priceCart(call, addr.id, m.restaurant.id, one);
          const pay = r.bill.toPay || 0;
          if (pay) {
            const under = pay <= budget;
            priced.push({
              label: "VALUE PICK", hero: "ON OFFER", items: one,
              restaurant: m.restaurant, itemTotal: r.bill.itemTotal || deal.price,
              pay, basePay: pay, coupon: "", saved: 0,
              taxes: r.bill.taxes, delivery: r.bill.delivery, under,
            });
            emit({
              type: "log",
              msg: `  ${under ? "<span class='k'>UNDER CAP</span>" : "over cap"} // ${m.restaurant.name} value pick <span style="color:var(--gold)">Rs ${pay}</span> (already discounted, no coupon possible)`,
              cls: under ? "win" : "sys",
            });
          }
        } catch { /* value pick is a bonus, never fatal */ }
      }
      await sleep(400);
    }

    try { await call("flush_food_cart", {}); } catch {}
    emit({ type: "tool", name: "deals", state: "done" });
    emit({ type: "log", msg: `cart flushed // nothing ordered`, cls: "sys" });

    const under = priced.filter((p) => p.under).sort((a, b) => a.pay - b.pay);
    const over = priced.filter((p) => !p.under).sort((a, b) => a.pay - b.pay);
    if (!under.length) {
      emit({ type: "log", msg: `nothing lands under Rs ${budget} // cheapest real price was Rs ${over[0] ? over[0].pay : "?"}`, cls: "fire" });
    } else {
      emit({ type: "log", msg: `<span class="k">${under.length}</span> meals actually cost under Rs ${budget} // cheapest Rs ${under[0].pay}`, cls: "win" });
    }
    emit({
      type: "combos", orderable: true, verified: true,
      addressId: addr.id, addressLabel: addr.tag || "addr", budget,
      combos: [...under, ...over.slice(0, 6)],
    });
    emit({ type: "done" });
  } catch (e) {
    emit({ type: "error", msg: "live error // " + (e?.message || e) });
    emit({ type: "fallback" });
  } finally {
    await client.close();
  }
  return true;
}

async function instamart(client, call, addr, query, budget, veg, emit) {
  emit({ type: "tool", name: "search", state: "run" });
  emit({ type: "log", msg: `call <span class="k">search_products</span>("${query.slice(0, 22)}")` });
  let items = parseItems(textOf(await call("search_products", { addressId: addr.id, query })));
  if (veg) items = items.filter((i) => !isNonVeg(i.tags));
  for (let i = 0; i < Math.max(5, Math.min(items.length, 12)); i++) { emit({ type: "kitchen" }); await sleep(60); }
  emit({ type: "tool", name: "search", state: "done" });
  emit({ type: "tool", name: "deals", state: "done" });
  emit({ type: "log", msg: `found <span class="k">${items.length}</span> real products`, cls: "win" });

  emit({ type: "tool", name: "cart", state: "run" });
  const combos = buildMeals(items, query, budget, veg, { id: "", name: "Instamart", rating: 0, eta: 15 });
  emit({ type: "tool", name: "cart", state: "done" });
  if (!combos.length) { emit({ type: "log", msg: "no basket fits the budget", cls: "fire" }); emit({ type: "done" }); return true; }
  emit({ type: "log", msg: `built <span class="k">${combos.length}</span> baskets`, cls: "win" });
  emit({ type: "combos", orderable: false, addressId: addr.id, addressLabel: addr.tag || "addr", budget, combos });
  emit({ type: "done" });
  return true;
}
