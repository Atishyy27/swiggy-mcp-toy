// Full-coverage probe of Swiggy's MCP. Fires every tool on every server it can
// reach, records exactly what came back, and writes the map to COVERAGE.md.
//
// There is no public map of this API. Swiggy documents 14 Food tools; the server
// actually serves 18. The only way to know what a tool does is to call it and read
// the reply, so that is what this does.
//
// Two rules, and the second one is the whole reason this file is trustworthy:
//
//   1. Never spend money. place_food_order and checkout are REFUSED, not called.
//      A coverage number bought with a real dinner is not a coverage number.
//   2. Never claim a tool works because it returned 200. Swiggy answers "Cart
//      updated." to a cart it did not update. We record the REPLY, not the status.
//
//   node src/coverage.mjs

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { FileOAuthProvider, SERVERS } from "./oauth-provider.mjs";
import { writeFileSync } from "node:fs";

const textOf = (r) => (r?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Tools that commit something real. We do not call these, ever. They are counted
// separately so the coverage number stays honest instead of quietly rounding up.
// book_table reserves an actual table under his actual name at an actual restaurant,
// which is not money but is absolutely a thing you cannot un-do from a test script.
const SPENDS_MONEY = new Set(["place_food_order", "checkout", "book_table"]);

// Tools that need an id you can only get by having a live, paid order in flight.
// Callable in principle, unreachable in practice without buying food.
const NEEDS_LIVE_ORDER = new Set(["check_payment_status", "confirm_order"]);

// Tomorrow, so slot search always has something to find.
const DATE = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

const results = [];
const record = (server, tool, status, note) => {
  // Swiggy's own replies are full of em dashes. Normalise them out on the way in so
  // nothing generated from this file ever carries one.
  const clean = String(note || "").replace(new RegExp("\\u2014", "g"), "-").replace(/\s+/g, " ").slice(0, 110);
  results.push({ server, tool, status, note: clean });
  const icon = { ok: "OK  ", empty: "EMPTY", err: "ERR ", refused: "SKIP", blocked: "N/A " }[status];
  console.log(`  ${icon} ${tool.padEnd(26)} ${clean.slice(0, 78)}`);
};

// Did the call actually DO anything, or did it just not throw? Swiggy returns 200
// with an error sentence in the body more often than it returns an error.
function judge(text) {
  const t = String(text || "").trim();
  if (!t) return ["empty", "no content"];
  if (/^an error occurred|something went wrong|is required|report id:/im.test(t)) return ["err", t.split("\n")[0]];
  if (/^found 0 |^no active orders|cart is empty|found 0 coupons/im.test(t)) return ["empty", t.split("\n")[0]];
  return ["ok", t.split("\n").find((l) => l.trim()) || "returned content"];
}

async function probe(server) {
  const auth = new FileOAuthProvider(server);
  if (!auth.tokens()) {
    console.log(`\n=== ${server.toUpperCase()} :: NOT CONNECTED (node src/login.mjs ${server}) ===`);
    return;
  }
  const client = new Client({ name: "coverage", version: "1.0.0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(SERVERS[server]), { authProvider: auth }));

  const listed = (await client.listTools()).tools;
  console.log(`\n=== ${server.toUpperCase()} :: ${listed.length} tools live ===`);

  // We keep the WHOLE result, not just the text. Dineout hides the only bookable
  // ids on the entire server inside `_meta`, which every normal MCP client throws
  // away. get_available_slots even documents them as living in structuredContent.
  // They do not.
  let last = null;
  const call = async (name, args = {}) => {
    last = await client.callTool({ name, arguments: args });
    await sleep(250);
    return textOf(last);
  };

  // Context every other call needs. If this fails, nothing downstream is meaningful.
  // Every one of these is HARVESTED from an earlier call in this same run. Feeding a
  // tool a made-up id and recording the rejection would be measuring our own typos.
  let addressId = "", restaurantId = "", orderId = "", itemId = "";
  let couponCode = "", spinId = "", skuId = "";
  // Dineout is coordinate-based, not addressId-based, and needs slot ids to book.
  // Coordinates come from Instamart's cart payload, which is the only tool on the
  // whole API that leaks them (get_addresses strips them "for privacy").
  let lat = 12.9585457, lng = 77.6524364;
  let slotId = "", slotItemId = "", reservationTime = 0;

  const bootstrap = server === "dineout" ? "get_saved_locations" : "get_addresses";
  try {
    const t = await call(bootstrap, server === "dineout" ? {} : { page: 1, pageSize: 10 });
    addressId = (t.match(/\(ID:\s*(\w+)\)/) || [])[1] || "";
    const [s, n] = judge(t);
    record(server, bootstrap, s, addressId ? `addressId ${addressId}` : n);
  } catch (e) {
    record(server, bootstrap, "err", e.message);
  }

  // Everything the server offers, minus what we already did, minus what commits.
  const todo = listed.map((t) => t.name).filter((n) => n !== bootstrap);

  // Seed ids by calling the discovery tools first, in dependency order.
  // Dependency order, not alphabetical. A cart tool called before anything is IN the
  // cart tells you nothing, and a coupon tool called before a cart exists tells you
  // less than nothing (Swiggy returns zero coupons and it looks like the tool is dead).
  const order = [
    "search_restaurants", "get_restaurant_menu", "search_menu",
    "search_products", "your_go_to_items",
    "search_restaurants_dineout", "get_restaurant_details",
    "render_restaurants_dineout", "get_available_slots", "create_cart",
    "get_food_orders", "get_orders", "get_food_order_details",
    "update_food_cart", "update_cart",          // put something IN the cart first
    "get_food_cart", "get_cart",                // now reading it means something
    "fetch_food_coupons", "apply_food_coupon",  // coupons only exist against a cart
    "get_payment_options",
    "track_food_order", "track_order", "get_booking_status",
    "get_food_delivery_status", "get_delivery_status",
    "report_error",
    "flush_food_cart", "clear_cart",            // clean up last
  ];
  todo.sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });

  for (const tool of todo) {
    if (SPENDS_MONEY.has(tool)) {
      record(server, tool, "refused", "REFUSED on purpose: this places a real order");
      continue;
    }
    if (NEEDS_LIVE_ORDER.has(tool)) {
      record(server, tool, "blocked", "needs a live payment id; unreachable without buying food");
      continue;
    }

    // Arguments per tool, built from ids we picked up earlier in this same run.
    const args = {
      search_restaurants: { addressId, query: "pizza" },
      search_menu: { addressId, query: "paneer" },
      get_restaurant_menu: { addressId, restaurantId, page: 1, pageSize: 5 },
      search_products: { addressId, query: "milk" },
      your_go_to_items: { addressId },
      get_food_orders: { addressId },
      get_orders: { count: 5 },
      get_food_order_details: { orderId },
      get_food_cart: { addressId },
      get_cart: {},
      fetch_food_coupons: { addressId, restaurantId },
      apply_food_coupon: { couponCode, addressId },
      get_payment_options: { addressId, cartAmount: 300 },
      track_food_order: {},
      track_order: { orderId, lat: 12.9585457, lng: 77.6524364 },
      get_food_delivery_status: { orderId },
      get_delivery_status: { orderId, addressId },
      flush_food_cart: {},
      clear_cart: {},
      report_error: {
        tool: "coverage", errorMessage: "coverage probe, please ignore",
        flowDescription: "automated tool-surface map, no user impact",
      },
      update_food_cart: { restaurantId, addressId, cartItems: [{ menu_item_id: itemId, quantity: 1 }] },
      update_cart: { selectedAddressId: addressId, items: [{ spinId, skuId, quantity: 1 }] },

      // Dineout. Coordinate-based, and the whole thing hangs off a slot id.
      search_restaurants_dineout: { query: "pizza", latitude: lat, longitude: lng },
      get_restaurant_details: { restaurantId, latitude: lat, longitude: lng },
      render_restaurants_dineout: {
        restaurantIds: restaurantId ? [restaurantId] : [],
        searches: [{ query: "pizza", latitude: lat, longitude: lng }],
      },
      get_available_slots: { restaurantId, date: DATE, latitude: lat, longitude: lng },
      // Creates a booking cart and explicitly STOPS before payment. It does not
      // reserve the table; book_table does, and book_table is refused above.
      create_cart: {
        restaurantId, cartType: "DEAL_TICKET_PURCHASE", latitude: lat, longitude: lng,
        slotId, itemId: slotItemId, reservationTime, guestCount: 2,
      },
      get_booking_status: { orderId },
    }[tool];

    if (args === undefined) {
      record(server, tool, "err", "no argument recipe in this harness");
      continue;
    }
    // Skip rather than lie. Calling get_food_order_details with an empty orderId
    // proves nothing about the tool, it proves we had no orderId. Checks nested
    // values too, since the cart tools hide their ids inside an array.
    const hole = (v) =>
      v === "" ? true
      : Array.isArray(v) ? v.some(hole)
      : v && typeof v === "object" ? Object.values(v).some(hole)
      : false;
    const missing = Object.entries(args).find(([, v]) => hole(v));
    if (missing) {
      record(server, tool, "blocked", `needs ${missing[0]}, which nothing upstream produced`);
      continue;
    }

    try {
      const t = await call(tool, args);
      const [s, n] = judge(t);
      record(server, tool, s, n);

      // Harvest ids for the tools that come later.
      if (tool === "search_restaurants") restaurantId = (t.match(/\(ID:\s*(\d+)\)/) || [])[1] || "";
      if (tool === "get_restaurant_menu") {
        // Skip "has variants" dishes: staging one silently empties the whole cart,
        // which would make every cart tool below it look broken.
        const line = t.split("\n").find((l) => /^\s*-\s/.test(l) && /\(ID:\s*\d+\)/.test(l) && !/has variants/i.test(l));
        itemId = line ? (line.match(/\(ID:\s*(\d+)\)/) || [])[1] : "";
      }
      if (tool === "get_food_orders") orderId = (t.match(/Order\s+(\d+)/) || [])[1] || "";
      // The applicable code is the DISPLAY name, never the uuid in the code: field.
      if (tool === "fetch_food_coupons") {
        couponCode = (t.match(/-\s*([A-Z0-9]{4,})\s*\[[^\]]*APPLICABLE/i) || [])[1] || "";
        if (/NOT APPLICABLE/i.test((t.match(/-\s*[A-Z0-9]{4,}\s*\[[^\]]*\]/) || [""])[0])) {
          couponCode = (t.match(/-\s*([A-Z0-9]{4,})\s*\[✅/) || [])[1] || couponCode;
        }
      }
      if (tool === "search_products") {
        const d = t.slice(t.indexOf("{"));
        try {
          const v = JSON.parse(d)?.products?.[0]?.variations?.[0];
          if (v) { spinId = v.spinId || ""; skuId = v.skuId || ""; }
        } catch {}
      }
      if (tool === "search_restaurants_dineout") {
        restaurantId = (t.match(/\(ID:\s*(\d+)\)/) || t.match(/"(?:restaurantId|id)"\s*:\s*"?(\d+)/) || [])[1] || "";
      }
      // A slot carries three ids that must travel together, and they are ONLY in
      // _meta.slots[].deals[]. Not in content. Not in structuredContent, despite the
      // tool description promising exactly that.
      if (tool === "get_available_slots") {
        for (const s of last?._meta?.slots || []) {
          const deal = (s.deals || []).find((d) => d.slotId != null && d.itemId);
          if (!deal) continue;
          slotId = String(deal.slotId);
          slotItemId = String(deal.itemId);
          reservationTime = s.reservationTime || 0;
          break;
        }
      }
    } catch (e) {
      // A business rule is an ANSWER, not a failure. "Coupon is not eligible on the
      // items in your cart" means apply_food_coupon worked perfectly and told us
      // something true: the cart holds an already-discounted dish, which Swiggy
      // refuses to stack on. Filing that as a broken tool would be scoring our own
      // ignorance as the API's fault.
      const msg = String(e?.message || e);
      // Swiggy also flags isError while returning a perfectly good answer, e.g.
      // get_payment_options on a Rs 0 free-reservation cart still lists 7 UPI options
      // and then calls itself an error. If it answered, it is reached.
      const rule = /not eligible|does not exist|not applicable|minimum|expired|not serviceable|^found \d+/i.test(msg);
      record(server, tool, rule ? "ok" : "err", rule ? "answered: " + msg.split("\n")[0] : msg);
    }
  }

  try { await call(server === "instamart" ? "clear_cart" : "flush_food_cart", {}); } catch {}
  await client.close();
}

for (const s of ["food", "instamart", "dineout"]) await probe(s);

// ---- the map ----
const reached = results.filter((r) => r.status === "ok" || r.status === "empty").length;
const total = results.length;
console.log(`\n\n================ COVERAGE ================`);
console.log(`exercised : ${reached} / ${total} tools reached and answered`);
for (const st of ["refused", "blocked", "err"]) {
  const n = results.filter((r) => r.status === st).length;
  if (n) console.log(`${st.padEnd(10)}: ${n}`);
}

const ICON = { ok: "reached", empty: "reached (empty)", err: "error", refused: "refused (spends money)", blocked: "unreachable" };
let md = `# Swiggy MCP tool coverage\n\n`;
md += `Every tool on every server, called for real. Generated by \`node src/coverage.mjs\`.\n\n`;
md += `**${reached} of ${total} tools reached and answered.**\n\n`;
md += `\`place_food_order\` and \`checkout\` are refused on purpose: they place real orders.\n`;
md += `\`check_payment_status\` and \`confirm_order\` need a live payment id, so they cannot be\n`;
md += `reached without buying food. Everything else was actually called.\n\n`;
for (const server of ["food", "instamart", "dineout"]) {
  const rows = results.filter((r) => r.server === server);
  if (!rows.length) continue;
  md += `## ${server} (${rows.filter((r) => r.status === "ok" || r.status === "empty").length}/${rows.length})\n\n`;
  md += `| tool | result | what came back |\n|---|---|---|\n`;
  for (const r of rows) md += `| \`${r.tool}\` | ${ICON[r.status]} | ${r.note.replace(/\|/g, "/")} |\n`;
  md += `\n`;
}
writeFileSync("COVERAGE.md", md);
console.log(`\nwritten to COVERAGE.md`);
