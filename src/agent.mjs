// LIVE Swiggy MCP agent. Discovers your real address, restaurants, menu, and
// coupons, then generates several budget-fitting COMBOS ("formations") for you
// to pick from. Ordering is a separate, explicit 2-step flow (stage -> place)
// so nothing is bought without confirmation.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { FileOAuthProvider, SERVERS } from "./oauth-provider.mjs";

const textOf = (r) => (r?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const parseAddresses = (t) => {
  const out = [], re = /(\d+)\.\s*(?:\[([^\]]*)\]\s*)?([^:]+):\s*(.+?)\s*\(ID:\s*(\w+)\)/g;
  let m; while ((m = re.exec(t))) out.push({ tag: (m[2] || "").trim(), name: m[3].trim(), addr: m[4].trim(), id: m[5] });
  return out;
};
const parseRestaurants = (t) => {
  const out = [], re = /(\d+)\.\s*(.+?)\s*(?:\(Ad\)\s*)?\u2014\s*(.+?)\s*\|\s*([\d.]+)★\s*\|\s*(\d+)\s*min\s*\|\s*₹(\d+)\s*for two\s*\(ID:\s*(\d+)\)/g;
  let m; while ((m = re.exec(t))) out.push({ name: m[2].trim(), cuisines: m[3].trim(), rating: +m[4], eta: +m[5], for2: +m[6], id: m[7] });
  return out;
};
const parseItems = (t) => {
  const out = [], re = /-\s*(.+?)\s*\u2014\s*₹(\d+)\s*\|\s*([^\[\n(]*)(?:\[image[^\]]*\])?\s*\(ID:\s*(\d+)\)/g;
  let m; while ((m = re.exec(t))) out.push({ name: m[1].trim(), price: +m[2], tags: m[3].trim(), id: m[4] });
  return out;
};
const parseCoupons = (t) => {
  const out = [], re = /-\s*([A-Z0-9]+)\s*\[([^\]]*)\]\s*\u2014\s*(.+?)\s*\(code:\s*([^)]+)\)/g;
  let m; while ((m = re.exec(t))) out.push({ code: m[1], applicable: !/not applicable/i.test(m[2]), desc: m[3].trim() });
  return out;
};

const isNonVeg = (t = "") => /non[-\s]?veg/i.test(t);
const isVeg = (t = "") => /veg/i.test(t) && !isNonVeg(t);

function emojiFor(s = "") {
  s = s.toLowerCase();
  if (/biry|rice|pulao/.test(s)) return "🍛";
  if (/pizza/.test(s)) return "🍕";
  if (/burger/.test(s)) return "🍔";
  if (/noodle|ramen|chinese|hakka|manch/.test(s)) return "🍜";
  if (/roll|shawarma|wrap|frankie/.test(s)) return "🌯";
  if (/chicken|kebab|tandoor|tikka|wing/.test(s)) return "🍗";
  if (/cake|choc|dessert|sweet|ice|gelato|brownie/.test(s)) return "🍰";
  if (/coffee|tea|shake|juice|lemon|cola|beverage|lassi/.test(s)) return "🥤";
  if (/egg/.test(s)) return "🥚";
  if (/naan|roti|bread|kulcha|paratha/.test(s)) return "🫓";
  if (/paneer|veg|dal|aloo|salad/.test(s)) return "🥗";
  return "🍽️";
}

// Build several distinct budget-fitting combos with different characters.
function generateCombos(items, query, budget, veg) {
  let pool = items.filter((i) => i.price > 0 && i.price <= budget);
  if (veg) pool = pool.filter((i) => isVeg(i.tags));
  if (!pool.length) return [];
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const craving = (it) => words.some((w) => (it.name + " " + it.tags).toLowerCase().includes(w));

  const fill = (sorted) => {
    const chosen = [], seen = new Set();
    let total = 0;
    for (const it of sorted) {
      if (seen.has(it.id) || total + it.price > budget) continue;
      chosen.push({ ...it, quantity: 1 }); seen.add(it.id); total += it.price;
      if (chosen.length >= 6 && total >= budget * 0.8) break;
    }
    return { items: chosen, total };
  };
  const byCraving = [...pool].sort((a, b) => (craving(b) - craving(a)) || (/bestseller/i.test(b.tags) - /bestseller/i.test(a.tags)) || b.price - a.price);
  const byBig = [...pool].sort((a, b) => b.price - a.price);
  const bySmall = [...pool].sort((a, b) => a.price - b.price);
  const rot = (arr, n) => arr.slice(n).concat(arr.slice(0, n));

  const raw = [
    { label: craving(byCraving[0]) ? "CRAVING MATCH" : "CHEF'S PICK", ...fill(byCraving) },
    { label: "BIG MAINS", ...fill(byBig) },
    { label: "MAX VARIETY", ...fill(bySmall) },
    { label: "WILDCARD", ...fill(rot(byCraving, 2)) },
    { label: "STACKED", ...fill(rot(byBig, 1)) },
  ];
  const seen = new Set(), out = [];
  for (const c of raw) {
    if (!c.items.length) continue;
    const key = c.items.map((i) => i.id).sort().join(",");
    if (seen.has(key)) continue;
    seen.add(key); out.push(c);
  }
  return out.slice(0, 5);
}

function newClient(server) {
  const provider = new FileOAuthProvider(server);
  const transport = new StreamableHTTPClientTransport(new URL(SERVERS[server]), { authProvider: provider });
  const client = new Client({ name: "feastmode-agent", version: "0.1.0" }, { capabilities: {} });
  return { provider, transport, client };
}
async function withClient(server, fn) {
  const { provider, transport, client } = newClient(server);
  if (!provider.tokens()) throw new Error(`not connected (${server})`);
  await client.connect(transport);
  try { return await fn(client); } finally { await client.close(); }
}

export async function listAddresses({ server = "food" }) {
  return withClient(server, async (c) => parseAddresses(textOf(await c.callTool({ name: "get_addresses", arguments: { page: 1, pageSize: 10 } }))));
}

// Stage a real cart and read back the real bill (reversible via cancelOrder).
export async function stageOrder({ server = "food", addressId, restaurantId, items }) {
  return withClient(server, async (c) => {
    const cartItems = items.map((i) => ({ menu_item_id: String(i.menu_item_id || i.id), quantity: i.quantity || 1 }));
    const up = await c.callTool({ name: "update_food_cart", arguments: { restaurantId: String(restaurantId), addressId, cartItems } });
    const cart = await c.callTool({ name: "get_food_cart", arguments: { addressId } });
    return { updated: textOf(up).slice(0, 600), cart: textOf(cart).slice(0, 1400) };
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
    await sleep(180);

    if (server === "instamart") return await instamart(client, call, addr, query, budget, veg, emit);

    emit({ type: "log", msg: `call <span class="k">search_restaurants</span>("${query.slice(0, 24)}")${veg ? " // veg" : ""}` });
    const rests = parseRestaurants(textOf(await call("search_restaurants", { addressId: addr.id, query })));
    for (const r of rests) {
      emit({ type: "kitchen", name: r.name });
      emit({ type: "log", msg: `  ${r.name} <span style="color:var(--dim)">${r.rating}★ ${r.eta}min ₹${r.for2}/2</span>`, cls: "sys" });
      await sleep(80);
    }
    emit({ type: "tool", name: "search", state: "done" });
    if (!rests.length) { emit({ type: "log", msg: "no restaurants parsed", cls: "fire" }); emit({ type: "done" }); await client.close(); return true; }
    emit({ type: "log", msg: `locked <span class="k">${rests.length}</span> real kitchens`, cls: "win" });

    const pick = [...rests].sort((a, b) => (b.rating - a.rating) || (a.for2 - b.for2))[0];
    emit({ type: "tool", name: "menu", state: "run" });
    emit({ type: "log", msg: `call <span class="k">get_restaurant_menu</span>(${pick.name})` });
    let items = [];
    for (const page of [1, 2]) {
      try { items = items.concat(parseItems(textOf(await call("get_restaurant_menu", { addressId: addr.id, restaurantId: pick.id, page })))); } catch {}
    }
    const byId = new Map(items.map((i) => [i.id, i])); items = [...byId.values()];
    if (veg) items = items.filter((i) => isVeg(i.tags));
    emit({ type: "tool", name: "menu", state: "done" });
    emit({ type: "log", msg: `menu parsed // <span class="k">${items.length}</span> ${veg ? "veg " : ""}dishes @ ${pick.name}`, cls: "win" });

    emit({ type: "tool", name: "deals", state: "run" });
    emit({ type: "log", msg: `call <span class="k">fetch_food_coupons</span>()`, cls: "fire" });
    try {
      const coupons = parseCoupons(textOf(await call("fetch_food_coupons", { addressId: addr.id, restaurantId: pick.id })));
      for (const c of coupons.slice(0, 5)) {
        emit({ type: "deal", tag: c.code, name: c.desc.slice(0, 38), gold: c.applicable });
        emit({ type: "log", msg: `  ${c.applicable ? "LIVE" : "locked"} coupon <span style="color:var(--gold)">${c.code}</span>`, cls: "hit" });
        await sleep(90);
      }
    } catch {}
    emit({ type: "tool", name: "deals", state: "done" });

    emit({ type: "tool", name: "cart", state: "run" });
    emit({ type: "log", msg: `computing formations under Rs ${budget}...` });
    const combos = generateCombos(items, query, budget, veg);
    emit({ type: "tool", name: "cart", state: "done" });
    if (!combos.length) { emit({ type: "log", msg: "no combos fit the budget // raise the cap", cls: "fire" }); emit({ type: "done" }); await client.close(); return true; }
    emit({ type: "log", msg: `built <span class="k">${combos.length}</span> formations // pick one to order`, cls: "win" });
    emit({
      type: "combos", orderable: true,
      restaurant: { id: pick.id, name: pick.name }, addressId: addr.id, addressLabel: addr.tag || "addr",
      combos: combos.map((c) => ({ label: c.label, total: c.total, items: c.items.map((i) => ({ name: i.name, price: i.price, emoji: emojiFor(i.name + " " + i.tags), menu_item_id: i.id, quantity: 1 })) })),
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
  for (let i = 0; i < Math.max(5, Math.min(items.length, 12)); i++) { emit({ type: "kitchen" }); await sleep(80); }
  emit({ type: "tool", name: "search", state: "done" });
  emit({ type: "tool", name: "deals", state: "done" });
  emit({ type: "log", msg: `found <span class="k">${items.length}</span> real products`, cls: "win" });

  emit({ type: "tool", name: "cart", state: "run" });
  const combos = generateCombos(items, query, budget, veg);
  emit({ type: "tool", name: "cart", state: "done" });
  if (!combos.length) { emit({ type: "log", msg: "no basket fits the budget", cls: "fire" }); emit({ type: "done" }); return true; }
  emit({ type: "log", msg: `built <span class="k">${combos.length}</span> baskets`, cls: "win" });
  emit({
    type: "combos", orderable: false,
    restaurant: { id: "", name: "Instamart" }, addressId: addr.id, addressLabel: addr.tag || "addr",
    combos: combos.map((c) => ({ label: c.label, total: c.total, items: c.items.map((i) => ({ name: i.name, price: i.price, emoji: emojiFor(i.name), menu_item_id: i.id, quantity: 1 })) })),
  });
  emit({ type: "done" });
  return true;
}
