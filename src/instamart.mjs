// Instamart deal oracle.
//
// Instamart is a completely different animal from Food, and that difference is
// the whole opportunity:
//
//   Food      replies in markdown. Discounts are CART-BOUND: you cannot know what
//             a coupon is worth until you stage a real cart and ask. One cart per
//             account, so the oracle is serial and slow (~5s per probe).
//
//   Instamart replies in JSON, and hands you mrp + offerPrice FOR EVERY PACK SIZE
//             up front. No cart. No probing. Which means the arbitrage is pure
//             arithmetic and it is instant.
//
// The arbitrage: Swiggy prices pack sizes independently, so the price per gram
// swings wildly between variants of the SAME product. Nobody divides 20 prices by
// 20 pack weights in their head. That is the entire edge.

const UNIT = [
  [/\b(kg|kilogram)\b/i, 1000, "g"],
  [/\b(g|gm|gram|grams)\b/i, 1, "g"],
  [/\b(l|ltr|litre|liter)\b/i, 1000, "ml"],
  [/\b(ml|millilitre)\b/i, 1, "ml"],
  [/\b(pc|pcs|piece|pieces|unit|units|n)\b/i, 1, "pc"],
];

// "75 g x 3" -> 225 g. "6 x 100 ml" -> 600 ml. "1 kg" -> 1000 g. "41.75 g" -> 41.75 g.
// Returns null when the size is unparseable, and null MUST mean "excluded from the
// comparison", never "assume 1". A silently-wrong denominator is worse than no answer.
export function parseQty(desc = "") {
  const s = String(desc).trim();
  if (!s) return null;

  // A leading or trailing multiplier: "6 x 100 g" or "75 g x 3".
  let mult = 1;
  let body = s;
  const lead = s.match(/^\s*(\d+)\s*[x*]\s*(.+)$/i);
  const trail = s.match(/^(.+?)\s*[x*]\s*(\d+)\s*$/i);
  if (lead) { mult = +lead[1]; body = lead[2]; }
  else if (trail) { mult = +trail[2]; body = trail[1]; }

  const num = body.match(/([\d.]+)/);
  if (!num) return null;
  const value = parseFloat(num[1]);
  if (!Number.isFinite(value) || value <= 0) return null;

  for (const [re, factor, unit] of UNIT) {
    if (re.test(body)) return { qty: value * factor * mult, unit, label: s };
  }
  // A bare count, e.g. "4" or "pack of 6".
  const pack = s.match(/pack of\s*(\d+)/i);
  if (pack) return { qty: +pack[1], unit: "pc", label: s };
  return null;
}

// Instamart replies with prose, then a literal "Data:" line, then one JSON object.
export function parseData(text = "") {
  const i = String(text).indexOf("Data:");
  if (i < 0) return null;
  const j = String(text).indexOf("{", i);
  if (j < 0) return null;
  try {
    return JSON.parse(String(text).slice(j));
  } catch {
    return null;
  }
}

// Keep unit prices at full precision for COMPARISON and round only for DISPLAY.
// Rounding first and comparing after is how you report an 8% premium that is
// really 5.4%: at Rs 0.24/g, two decimal places is a 4% quantisation error, and
// the whole pitch here is that the arithmetic holds up.
const show = (n) => (n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n.toFixed(3));

// Flatten search_products / your_go_to_items into one row per BUYABLE variant,
// each carrying the unit price that makes variants comparable.
export function flattenProducts(data) {
  const out = [];
  for (const p of data?.products || []) {
    for (const v of p.variations || []) {
      if (v.isInStockAndAvailable === false) continue;
      const price = v.price?.offerPrice ?? v.price?.mrp;
      const mrp = v.price?.mrp ?? price;
      if (!price || price <= 0) continue;
      const q = parseQty(v.quantityDescription);
      out.push({
        productId: p.productId,
        parentId: p.parentProductId || p.productId,
        product: p.displayName || v.displayName || "",
        brand: p.brand || v.brandName || "",
        promoted: !!p.isPromoted,
        spinId: v.spinId,
        skuId: v.skuId,
        size: v.quantityDescription || "",
        image: v.imageUrl || "",
        mrp,
        price,
        off: mrp > price ? Math.round(((mrp - price) / mrp) * 100) : 0,
        qty: q?.qty ?? null,
        unit: q?.unit ?? null,
        unitPrice: q ? price / q.qty : null,      // full precision, for comparison
        unitLabel: q ? show(price / q.qty) : null, // rounded, for humans
      });
    }
  }
  return out;
}

// The headline. For each product, which pack size is actually the cheapest per
// gram, and how badly does the worst one rip you off?
//
// We only ever compare variants of the SAME product carrying the SAME unit. A
// "per gram" number is meaningless across a biscuit and a shampoo, and comparing
// grams to millilitres is how you ship a confidently wrong answer.
export function packArbitrage(rows) {
  const byProduct = new Map();
  for (const r of rows) {
    if (r.unitPrice == null) continue;
    const key = r.parentId + "|" + r.unit;
    if (!byProduct.has(key)) byProduct.set(key, []);
    byProduct.get(key).push(r);
  }

  const deals = [];
  for (const variants of byProduct.values()) {
    if (variants.length < 2) continue;
    const sorted = [...variants].sort((a, b) => a.unitPrice - b.unitPrice);
    const best = sorted[0];
    const worst = sorted[sorted.length - 1];
    if (worst.unitPrice <= best.unitPrice) continue; // flat pricing, no edge

    const premium = Math.round(((worst.unitPrice - best.unitPrice) / best.unitPrice) * 100);
    // What the wrong pack actually costs you, in rupees, for the amount the worst
    // pack contains. This is the number that makes it land.
    const overpay = Math.round((worst.unitPrice - best.unitPrice) * worst.qty);

    // The purest form of the trick, and the one nobody believes until they look:
    // the two packs cost the SAME RUPEES and one is simply bigger. There is no
    // trade-off to weigh, no budget to balance. One of them is strictly worse.
    const twin = sorted.find((v) => v.price === worst.price && v.qty > worst.qty);
    const samePrice = twin && twin !== worst
      ? { price: worst.price, more: Math.round(((twin.qty - worst.qty) / worst.qty) * 100), big: twin, small: worst }
      : null;

    deals.push({ kind: "pack", best, worst, variants: sorted, premium, overpay, samePrice });
  }
  // A same-price gap is strictly more compelling than a percentage, so it leads.
  return deals.sort((a, b) => (b.samePrice ? 1 : 0) - (a.samePrice ? 1 : 0) || b.premium - a.premium);
}

// Across everything the search returned: the flat-out cheapest way to buy this
// thing by weight, regardless of brand. "The cheapest oreo per gram is not Oreo."
export function cheapestPerUnit(rows) {
  const byUnit = new Map();
  for (const r of rows) {
    if (r.unitPrice == null) continue;
    if (!byUnit.has(r.unit)) byUnit.set(r.unit, []);
    byUnit.get(r.unit).push(r);
  }
  const out = [];
  for (const [unit, list] of byUnit) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => a.unitPrice - b.unitPrice);
    out.push({ unit, ranked: sorted.slice(0, 12), best: sorted[0] });
  }
  // Most-populated unit first: that is the one the query was really about.
  return out.sort((a, b) => b.ranked.length - a.ranked.length);
}

// Straight markdowns, biggest first. Cheap to compute, and it is what a human
// actually scans for.
export const bestMarkdowns = (rows) =>
  rows.filter((r) => r.off > 0).sort((a, b) => b.off - a.off || a.price - b.price).slice(0, 12);
