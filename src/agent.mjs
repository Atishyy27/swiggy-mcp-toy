// LIVE mission: drive the real Swiggy MCP with the actual tool flow and stream
// HUD events. Uses your saved delivery address, real restaurant search, real
// menu prices, and real coupons; fills a cart toward your budget. Read-only:
// it never calls update_cart / place_order (no accidental real orders).

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
  let m; while ((m = re.exec(t))) out.push({ name: m[2].trim(), cuisines: m[3].trim(), rating: m[4], eta: +m[5], for2: +m[6], id: m[7] });
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

// Choose items that match the craving + bestsellers, filling toward the cap
// (mains first, not just the cheapest breads).
function selectForBudget(items, query, budget) {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const score = (it) => {
    const s = (it.name + " " + it.tags).toLowerCase();
    let v = /bestseller/i.test(it.tags) ? 2 : 0;
    for (const w of words) if (s.includes(w)) v += 3;
    return v;
  };
  const pool = items.filter((i) => i.price > 0 && i.price <= budget).sort((a, b) => score(b) - score(a) || b.price - a.price);
  const cart = [];
  let total = 0;
  for (const it of pool) {
    if (total + it.price > budget) continue;
    cart.push(it); total += it.price;
    if (cart.length >= 8 || (total >= budget * 0.82 && cart.length >= 3)) break;
  }
  return { cart, total };
}

function emojiFor(s = "") {
  s = s.toLowerCase();
  if (/biry|rice/.test(s)) return "🍛";
  if (/pizza/.test(s)) return "🍕";
  if (/burger/.test(s)) return "🍔";
  if (/noodle|ramen|chinese|hakka/.test(s)) return "🍜";
  if (/roll|shawarma|wrap/.test(s)) return "🌯";
  if (/chicken|kebab|tandoor|tikka/.test(s)) return "🍗";
  if (/cake|choc|dessert|sweet|ice|gelato/.test(s)) return "🍰";
  if (/coffee|tea|shake|juice|lemon|beverage/.test(s)) return "🥤";
  if (/egg/.test(s)) return "🥚";
  if (/paneer|veg|dal|aloo/.test(s)) return "🥗";
  return "🍽️";
}

export async function runLiveMission({ server = "food", query, budget = 800, emit }) {
  const provider = new FileOAuthProvider(server);
  if (!provider.tokens()) {
    emit({ type: "error", msg: `not connected // click CONNECT SWIGGY (${server})` });
    return false;
  }
  const transport = new StreamableHTTPClientTransport(new URL(SERVERS[server]), { authProvider: provider });
  const client = new Client({ name: "feastmode-agent", version: "0.1.0" }, { capabilities: {} });

  try {
    await client.connect(transport);
  } catch (e) {
    if (e instanceof UnauthorizedError) emit({ type: "error", msg: "session expired // reconnect" });
    else emit({ type: "error", msg: "connect failed // " + (e?.message || e) });
    return false;
  }
  const call = async (name, args) => {
    emit({ type: "call" });
    return client.callTool({ name, arguments: args });
  };
  emit({ type: "log", msg: `LIVE // connected to Swiggy ${server.toUpperCase()} MCP`, cls: "win" });

  try {
    // 1. real delivery address
    emit({ type: "tool", name: "search", state: "run" });
    emit({ type: "log", msg: 'call <span class="k">get_addresses</span>()' });
    const addrs = parseAddresses(textOf(await call("get_addresses", { page: 1, pageSize: 10 })));
    if (!addrs.length) {
      emit({ type: "log", msg: "no saved address on this Swiggy account // add one in the app", cls: "fire" });
      emit({ type: "done" }); await client.close(); return true;
    }
    // pick address by hint in the query, else most-recent (first)
    const hinted = addrs.find((a) => query.toLowerCase().includes((a.tag || "").toLowerCase()) && a.tag);
    const addr = hinted || addrs[0];
    emit({ type: "log", msg: `delivering to <span class="k">[${addr.tag || "addr"}]</span> ${addr.addr.slice(0, 46)}`, cls: "hit" });
    await sleep(200);

    if (server === "instamart") return await instamart(client, call, addr, query, budget, emit);

    // 2. search restaurants (real)
    emit({ type: "log", msg: `call <span class="k">search_restaurants</span>("${query.slice(0, 26)}")` });
    const rests = parseRestaurants(textOf(await call("search_restaurants", { addressId: addr.id, query })));
    for (const r of rests) {
      emit({ type: "kitchen" });
      emit({ type: "log", msg: `  ${r.name} <span style="color:var(--dim)">${r.rating}★ ${r.eta}min ₹${r.for2}/2</span>`, cls: "sys" });
      await sleep(90);
    }
    emit({ type: "tool", name: "search", state: "done" });
    if (!rests.length) { emit({ type: "log", msg: "no restaurants parsed", cls: "fire" }); emit({ type: "done" }); await client.close(); return true; }
    emit({ type: "log", msg: `locked <span class="k">${rests.length}</span> real kitchens`, cls: "win" });

    // 3. pick a spot (best rating within a sane 2-person price), read its menu
    const pick = [...rests].sort((a, b) => (b.rating - a.rating) || (a.for2 - b.for2))[0];
    emit({ type: "tool", name: "menu", state: "run" });
    emit({ type: "log", msg: `call <span class="k">get_restaurant_menu</span>(${pick.name})` });
    const items = parseItems(textOf(await call("get_restaurant_menu", { addressId: addr.id, restaurantId: pick.id })));
    emit({ type: "tool", name: "menu", state: "done" });
    emit({ type: "log", msg: `menu parsed // <span class="k">${items.length}</span> real dishes`, cls: "win" });

    // 4. real coupons
    emit({ type: "tool", name: "deals", state: "run" });
    emit({ type: "log", msg: `call <span class="k">fetch_food_coupons</span>(${pick.name})`, cls: "fire" });
    let coupons = [];
    try { coupons = parseCoupons(textOf(await call("fetch_food_coupons", { addressId: addr.id, restaurantId: pick.id }))); } catch {}
    for (const c of coupons.slice(0, 5)) {
      emit({ type: "deal", tag: c.code, name: c.desc.slice(0, 40), save: 0, gold: c.applicable });
      emit({ type: "log", msg: `  ${c.applicable ? "LIVE" : "locked"} coupon // <span style="color:var(--gold)">${c.code}</span> ${c.desc.slice(0, 40)}`, cls: "hit" });
      await sleep(120);
    }
    emit({ type: "tool", name: "deals", state: "done" });

    // 5. fill a cart toward the budget (proposed only, never committed)
    emit({ type: "tool", name: "cart", state: "run" });
    emit({ type: "log", msg: `building proposed cart under Rs ${budget} @ ${pick.name}` });
    const { cart, total } = selectForBudget(items, query, budget);
    for (const it of cart) {
      emit({ type: "item", name: it.name, price: it.price, from: pick.name, emoji: emojiFor(it.name + " " + it.tags) });
      emit({ type: "log", msg: `  + ${it.name} @ Rs ${it.price}` });
      await sleep(260);
    }
    emit({ type: "tool", name: "cart", state: "done" });
    emit({ type: "log", msg: `proposed cart // Rs ${total} of Rs ${budget} cap // ${cart.length} items @ ${pick.name}`, cls: "win" });
    emit({ type: "tool", name: "order", state: "done" });
    emit({ type: "log", msg: "READY // this is real menu data. cart not committed (safe).", cls: "win" });
    emit({ type: "done" });
  } catch (e) {
    emit({ type: "error", msg: "live error // " + (e?.message || e) });
    emit({ type: "fallback" });
  } finally {
    await client.close();
  }
  return true;
}

async function instamart(client, call, addr, query, budget, emit) {
  emit({ type: "tool", name: "search", state: "run" });
  emit({ type: "log", msg: `call <span class="k">search_products</span>("${query.slice(0, 24)}")` });
  const items = parseItems(textOf(await call("search_products", { addressId: addr.id, query })));
  // dark-store pings for the radar
  const stores = [...new Set(items.map((i) => i.tags).filter(Boolean))].slice(0, 8);
  for (let i = 0; i < Math.max(4, stores.length); i++) { emit({ type: "kitchen" }); await sleep(90); }
  emit({ type: "tool", name: "search", state: "done" });
  emit({ type: "log", msg: `found <span class="k">${items.length}</span> real products`, cls: "win" });

  emit({ type: "tool", name: "deals", state: "done" });
  emit({ type: "tool", name: "cart", state: "run" });
  emit({ type: "log", msg: `building basket under Rs ${budget}` });
  const { cart, total } = selectForBudget(items, query, budget);
  for (const it of cart) {
    emit({ type: "item", name: it.name, price: it.price, from: "Instamart", emoji: emojiFor(it.name) });
    emit({ type: "log", msg: `  + ${it.name} @ Rs ${it.price}` });
    await sleep(240);
  }
  emit({ type: "tool", name: "cart", state: "done" });
  emit({ type: "tool", name: "order", state: "done" });
  emit({ type: "log", msg: `basket // Rs ${total} of Rs ${budget} // ${cart.length} items (not committed)`, cls: "win" });
  emit({ type: "done" });
  await client.close();
  return true;
}
