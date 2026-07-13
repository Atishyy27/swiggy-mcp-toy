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
function parseItems(t) {
  const re = new RegExp(
    "-\\s*(.+?)\\s*" + D + "\\s*\\u20b9([\\d.]+)\\s*\\|\\s*([^\\[\\n(]*)(?:\\[image[^\\]]*\\])?\\s*\\(ID:\\s*(\\d+)\\)",
    "g"
  );
  const out = [];
  let m;
  while ((m = re.exec(t))) out.push({ name: m[1].trim(), price: Math.round(parseFloat(m[2])), tags: m[3].trim(), id: m[4] });
  return out;
}

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

// Build several distinct budget-fitting formations from one kitchen's menu.
function combosFor(items, query, budget, veg, rest) {
  let pool = items.filter((i) => i.price > 0 && i.price <= budget);
  if (veg) pool = pool.filter((i) => isVeg(i.tags));
  if (!pool.length) return [];

  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
  const craving = (it) => words.some((w) => (it.name + " " + it.tags).toLowerCase().includes(w));
  const star = (it) => /bestseller/i.test(it.tags);

  const fill = (sorted, cap) => {
    const chosen = [], seen = new Set();
    let total = 0;
    for (const it of sorted) {
      if (seen.has(it.id) || total + it.price > budget) continue;
      chosen.push({ ...it, quantity: 1 });
      seen.add(it.id);
      total += it.price;
      if (chosen.length >= cap) break;
    }
    return { items: chosen, total };
  };

  const byCraving = [...pool].sort((a, b) => (craving(b) - craving(a)) || (star(b) - star(a)) || b.price - a.price);
  const byBig = [...pool].sort((a, b) => b.price - a.price);
  const bySmall = [...pool].sort((a, b) => a.price - b.price);
  const byStar = [...pool].sort((a, b) => (star(b) - star(a)) || b.price - a.price);
  const rot = (arr, n) => arr.slice(n).concat(arr.slice(0, n));

  const raw = [
    { label: words.length && craving(byCraving[0]) ? "CRAVING MATCH" : "CHEF PICK", ...fill(byCraving, 5) },
    { label: "BESTSELLERS", ...fill(byStar, 5) },
    { label: "BIG MAINS", ...fill(byBig, 4) },
    { label: "MAX VARIETY", ...fill(bySmall, 6) },
    { label: "WILDCARD", ...fill(rot(byCraving, 2), 5) },
  ];

  const seen = new Set(), out = [];
  for (const c of raw) {
    if (!c.items.length || c.total <= 0) continue;
    const key = c.items.map((i) => i.id).sort().join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      label: c.label,
      total: c.total,
      fit: Math.round((c.total / budget) * 100),
      restaurant: { id: rest.id, name: rest.name, rating: rest.rating, eta: rest.eta },
      items: c.items.map((i) => ({
        name: i.name, price: i.price, emoji: emojiFor(i.name + " " + i.tags),
        menu_item_id: i.id, quantity: 1, veg: isVeg(i.tags),
      })),
    });
  }
  return out;
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

    emit({ type: "tool", name: "deals", state: "run" });
    emit({ type: "log", msg: `real coupons are cart-bound // hunted at checkout on your live cart`, cls: "fire" });
    emit({ type: "deal", tag: "LIVE", name: "coupons hunted on the real cart", gold: true });
    emit({ type: "tool", name: "deals", state: "done" });

    emit({ type: "tool", name: "cart", state: "run" });
    emit({ type: "log", msg: `computing every formation under Rs ${budget}...` });
    let combos = menus.flatMap((m) => combosFor(m.items, query, budget, veg, m.rest));

    // Dedup identical baskets, then lead with the ones that use the budget best.
    const seen = new Set();
    combos = combos.filter((c) => {
      const k = c.restaurant.id + ":" + c.items.map((i) => i.menu_item_id).sort().join(",");
      if (seen.has(k)) return false;
      seen.add(k); return true;
    }).sort((a, b) => (b.fit - a.fit) || (b.restaurant.rating - a.restaurant.rating));

    emit({ type: "tool", name: "cart", state: "done" });
    if (!combos.length) {
      emit({ type: "log", msg: `nothing fits under Rs ${budget} // raise the cap`, cls: "fire" });
      emit({ type: "done" }); await client.close(); return true;
    }
    emit({ type: "log", msg: `built <span class="k">${combos.length}</span> formations across <span class="k">${new Set(combos.map((c) => c.restaurant.id)).size}</span> kitchens`, cls: "win" });
    emit({
      type: "combos", orderable: true,
      addressId: addr.id, addressLabel: addr.tag || "addr", budget,
      combos: combos.slice(0, 40),
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
  const combos = combosFor(items, query, budget, veg, { id: "", name: "Instamart", rating: 0, eta: 15 });
  emit({ type: "tool", name: "cart", state: "done" });
  if (!combos.length) { emit({ type: "log", msg: "no basket fits the budget", cls: "fire" }); emit({ type: "done" }); return true; }
  emit({ type: "log", msg: `built <span class="k">${combos.length}</span> baskets`, cls: "win" });
  emit({ type: "combos", orderable: false, addressId: addr.id, addressLabel: addr.tag || "addr", budget, combos });
  emit({ type: "done" });
  return true;
}
