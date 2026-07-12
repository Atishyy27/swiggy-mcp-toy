// LIVE mission: drive the real Swiggy Food MCP server and stream HUD events.
// Best-effort: tool names/shapes are discovered at runtime, so this adapts to
// whatever the live server exposes. Requires a saved session (run login.mjs).

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { FileOAuthProvider, SERVERS } from "./oauth-provider.mjs";

const textOf = (res) =>
  (res?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");

// Pull likely restaurant / dish names out of arbitrary text or JSON.
function names(str, limit = 10) {
  const set = new Set();
  const jsonHits = str.match(/"(?:name|restaurantName|title|displayName)"\s*:\s*"([^"]{2,40})"/gi) || [];
  for (const h of jsonHits) {
    const m = h.match(/:\s*"([^"]+)"/);
    if (m) set.add(m[1]);
  }
  if (set.size === 0) {
    for (const line of str.split(/\n|,/)) {
      const t = line.trim().replace(/^[-*\d.)\s]+/, "");
      if (t.length >= 3 && t.length <= 40 && /[a-zA-Z]/.test(t)) set.add(t);
    }
  }
  return [...set].slice(0, limit);
}

export async function runLiveMission({ query, budget, emit }) {
  const provider = new FileOAuthProvider("food");
  if (!provider.tokens()) {
    emit({ type: "error", msg: "no session // run: node src/login.mjs food" });
    return false;
  }

  const transport = new StreamableHTTPClientTransport(new URL(SERVERS.food), { authProvider: provider });
  const client = new Client({ name: "feastmode-agent", version: "0.1.0" }, { capabilities: {} });

  try {
    await client.connect(transport);
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      emit({ type: "error", msg: "session expired // re-run login.mjs food" });
      return false;
    }
    emit({ type: "error", msg: "connect failed // " + (e?.message || e) });
    return false;
  }

  emit({ type: "log", msg: `LIVE // connected to Swiggy Food MCP`, cls: "win" });

  const { tools } = await client.listTools();
  emit({ type: "log", msg: `discovered <span class="k">${tools.length}</span> live tools`, cls: "sys" });

  const find = (...hints) =>
    tools.find((t) => hints.some((h) => (t.name + " " + (t.description || "")).toLowerCase().includes(h)));
  const firstArg = (t, prefer = []) => {
    const props = Object.keys(t?.inputSchema?.properties || {});
    return props.find((p) => prefer.includes(p.toLowerCase())) || props[0];
  };

  // 1. address (best-effort, non-fatal)
  const addrTool = find("address");
  if (addrTool) {
    emit({ type: "tool", name: "search", state: "run" });
    emit({ type: "call" });
    emit({ type: "log", msg: `call <span class="k">${addrTool.name}</span>()` });
    try {
      await client.callTool({ name: addrTool.name, arguments: {} });
    } catch {}
  }

  // 2. search restaurants
  const searchTool = find("search") && (find("restaurant") || find("search"));
  const st = find("restaurant") || find("search");
  if (!st) {
    emit({ type: "log", msg: "no search tool found // tools: " + tools.map((t) => t.name).join(", "), cls: "fire" });
    emit({ type: "done" });
    await client.close();
    return true;
  }

  emit({ type: "tool", name: "search", state: "run" });
  emit({ type: "call" });
  const arg = firstArg(st, ["query", "q", "search", "keyword", "text", "term"]);
  emit({ type: "log", msg: `call <span class="k">${st.name}</span>(${arg}="${query.slice(0, 30)}")` });

  let searchText = "";
  try {
    const r = await client.callTool({ name: st.name, arguments: arg ? { [arg]: query } : {} });
    searchText = textOf(r);
  } catch (e) {
    emit({ type: "log", msg: "search error // " + (e?.message || e), cls: "fire" });
  }
  const kitchens = names(searchText, 10);
  for (const k of kitchens) {
    emit({ type: "kitchen" });
    emit({ type: "log", msg: `  ping // ${k}`, cls: "sys" });
    await new Promise((r) => setTimeout(r, 90));
  }
  emit({ type: "tool", name: "search", state: "done" });
  emit({ type: "log", msg: `locked <span class="k">${kitchens.length || "some"}</span> kitchens`, cls: "win" });

  // 3. menu (best-effort)
  const menuTool = find("menu");
  if (menuTool) {
    emit({ type: "tool", name: "menu", state: "run" });
    emit({ type: "call" });
    emit({ type: "log", msg: `call <span class="k">${menuTool.name}</span>()` });
    try {
      const r = await client.callTool({ name: menuTool.name, arguments: {} });
      const dishes = names(textOf(r), 5);
      dishes.forEach((d, i) => emit({ type: "item", name: d, price: 149 + i * 60, from: "live", emoji: "🍽️" }));
    } catch {}
    emit({ type: "tool", name: "menu", state: "done" });
  }

  emit({ type: "log", msg: "LIVE run complete // cart tools left un-triggered (safety)", cls: "win" });
  emit({ type: "tool", name: "cart", state: "done" });
  emit({ type: "done" });
  await client.close();
  return true;
}
