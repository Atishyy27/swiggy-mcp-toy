// Dineout deal oracle.
//
// The third surface, and it hides its money in the third different place:
//
//   Food      discounts are cart-bound. You must stage a cart to learn anything.
//   Instamart discounts are published per pack size, in JSON, for free.
//   Dineout   discounts exist, are already computed, and are simply NOT in the
//             response you are supposed to read.
//
// search_restaurants_dineout returns text that renders the rating as
// "[object Object]" and carries no offers at all. Its structuredContent is empty.
// Its _meta is empty. The offers are only reachable by calling
// render_restaurants_dineout, the tool whose documented job is to draw a UI widget.
//
// So on Dineout the arbitrage is not arithmetic, it is knowing which door to open.

// "Flat 20% off + 20% cashback" -> 40 effective. "10% cashback" -> 10.
// Cashback is not the same as a discount (you get it back later, often capped and
// often as credit), so it is tracked separately and never silently merged.
export function parseOffer(title = "") {
  const s = String(title);
  const flat = +((s.match(/(?:flat\s*)?(\d+)\s*%\s*off/i) || [])[1] || 0);
  const cash = +((s.match(/(\d+)\s*%\s*cashback/i) || [])[1] || 0);
  return { flat, cash, effective: flat + cash, title: s };
}

// One row per restaurant, with its best offer resolved.
export function rankVenues(cards, { minRating = 0 } = {}) {
  const out = [];
  for (const c of cards || []) {
    const offers = (c.offers || []).map((o) => parseOffer(o.offerTitle || ""));
    const bank = (c.bankOffers || []).map((o) => parseOffer(o.offerTitle || ""));
    const best = [...offers, ...bank].sort((a, b) => b.effective - a.effective)[0];
    if (!best || !best.effective) continue;

    const rating = parseFloat(c.rating?.value ?? c.avgRating ?? 0) || 0;
    const count = c.rating?.count ?? 0;
    out.push({
      id: c.id,
      name: c.name || "",
      area: c.locality || c.area || "",
      distance: c.distance || "",
      rating,
      ratingCount: count,
      costForTwo: c.costForTwo || "",
      flat: best.flat,
      cash: best.cash,
      effective: best.effective,
      offer: best.title,
      offers: [...offers, ...bank].map((o) => o.title),
    });
  }

  // A rating of 0 means UNRATED, not terrible. Swiggy returns 0 for brand-new or
  // low-traffic venues, and quietly treating that as a 0-star review would bury
  // them below places that are genuinely bad. Unrated venues are kept, and marked.
  const rated = out.filter((v) => v.rating >= minRating || v.rating === 0);

  // Biggest real discount first. Rating breaks ties, because a 50% discount at a
  // place nobody wants to eat at is not a deal, it is a warning.
  return rated.sort((a, b) => b.effective - a.effective || b.rating - a.rating);
}

// The honest trade-off. There is no single right answer between "50% off at 3.5
// stars" and "35% off at 4.4", so we do not pretend there is: we surface the
// frontier and let the human pick.
//
// A venue is on the frontier if nothing else is BOTH cheaper and better rated.
// Everything not on it is strictly dominated and can be ignored.
export function paretoFrontier(venues) {
  const rated = venues.filter((v) => v.rating > 0);
  return rated.filter((v) =>
    !rated.some((o) => o !== v && o.effective >= v.effective && o.rating >= v.rating &&
      (o.effective > v.effective || o.rating > v.rating))
  ).sort((a, b) => b.effective - a.effective);
}

// Slots come from get_available_slots, and ONLY from its _meta. Not its content,
// not its structuredContent, whatever the tool description claims.
export function readSlots(result) {
  const slots = result?._meta?.slots || [];
  const out = [];
  for (const s of slots) {
    for (const d of s.deals || []) {
      out.push({
        date: s.dateStr || "",
        time: s.displayTime || "",
        meal: s.slotGroupName || "",
        reservationTime: s.reservationTime || 0,
        slotId: d.slotId,
        itemId: d.itemId,
        free: !!d.isFree,
        price: d.bookingPrice || 0,
        discount: d.discountPercentage || 0,
        title: d.title || "",
      });
    }
  }
  return out;
}
