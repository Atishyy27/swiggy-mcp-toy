// FEASTMODE server: serves the UI, runs the full Swiggy MCP OAuth flow in the
// browser (one button, popup login, backend catches the callback), streams LIVE
// missions over SSE, and exposes the real live tool catalog. No external deps.
//
// Usage: node server.mjs   then open http://localhost:3000
// Click "CONNECT SWIGGY" in the UI - no terminal login needed.

import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname, normalize } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { FileOAuthProvider, SERVERS, clearSession } from "./src/oauth-provider.mjs";
import { runLiveMission, listAddresses, stageOrder, placeOrder, cancelOrder } from "./src/agent.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dir, "public");
const PORT = process.env.PORT || 3000;
const WEB_REDIRECT = `http://localhost:${PORT}/oauth/callback`;

// Single-user localhost: remember which vertical is mid-login for the callback.
let pendingAuth = null;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const json = (res, code, obj) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
};

const readBody = (req) =>
  new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch { resolve({}); } });
  });

function newClient(server, redirectUrl) {
  const provider = new FileOAuthProvider(server, redirectUrl ? { redirectUrl } : {});
  const transport = new StreamableHTTPClientTransport(new URL(SERVERS[server]), { authProvider: provider });
  const client = new Client({ name: "feastmode", version: "0.1.0" }, { capabilities: {} });
  return { provider, transport, client };
}

async function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p === "/") p = "/index.html";
  const file = normalize(join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) return res.writeHead(403).end("forbidden");
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}

const stamp = () => new Date().toISOString().slice(11, 19);
const logReq = (path, extra = "") => {
  if (path.startsWith("/api") || path === "/oauth/callback") console.log(`  [${stamp()}] ${path}${extra ? " " + extra : ""}`);
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const path = url.pathname;
  const q = url.searchParams.get("server");
  logReq(path, q ? `server=${q}` : "");

  try {
    if (path === "/api/health") return json(res, 200, { ok: true, mode: "feastmode" });

    // ---- auth: status ----
    if (path === "/api/auth/status") {
      const server = url.searchParams.get("server") || "food";
      const provider = new FileOAuthProvider(server);
      return json(res, 200, { server, connected: !!provider.tokens() });
    }

    // ---- auth: start (returns the Swiggy login URL for a popup) ----
    if (path === "/api/auth/start") {
      const server = url.searchParams.get("server") || "food";
      if (!SERVERS[server]) return json(res, 400, { error: "unknown server" });
      const { provider, transport, client } = newClient(server, WEB_REDIRECT);
      if (provider.tokens()) return json(res, 200, { connected: true });
      let authUrl;
      provider._onRedirect = (u) => (authUrl = u);
      try {
        await client.connect(transport);
        return json(res, 200, { connected: true }); // token was already valid
      } catch (e) {
        if (!(e instanceof UnauthorizedError)) throw e;
      }
      pendingAuth = { server };
      return json(res, 200, { connected: false, url: authUrl.toString() });
    }

    // ---- auth: OAuth redirect target ----
    if (path === "/oauth/callback") {
      const code = url.searchParams.get("code");
      const err = url.searchParams.get("error");
      const server = pendingAuth?.server || "food";
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      if (!code) {
        res.end(page("Authorization failed", err || "no code returned", false));
        return;
      }
      try {
        const { transport } = newClient(server, WEB_REDIRECT);
        await transport.finishAuth(code);
        pendingAuth = null;
        res.end(page("Connected", `Swiggy ${server.toUpperCase()} MCP is linked. Close this tab.`, true));
      } catch (e) {
        res.end(page("Token exchange failed", e?.message || String(e), false));
      }
      return;
    }

    // ---- auth: disconnect ----
    if (path === "/api/auth/logout") {
      const server = url.searchParams.get("server") || "food";
      clearSession(server);
      return json(res, 200, { ok: true });
    }

    // ---- live tool catalog ----
    if (path === "/api/tools") {
      const server = url.searchParams.get("server") || "food";
      const { provider, transport, client } = newClient(server);
      if (!provider.tokens()) return json(res, 401, { error: "not connected" });
      try {
        await client.connect(transport);
        const { tools } = await client.listTools();
        await client.close();
        return json(res, 200, {
          server,
          count: tools.length,
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description || "",
            params: Object.entries(t.inputSchema?.properties || {}).map(([k, v]) => ({
              name: k,
              type: v.type || "any",
              required: (t.inputSchema?.required || []).includes(k),
              desc: v.description || "",
            })),
          })),
        });
      } catch (e) {
        if (e instanceof UnauthorizedError) return json(res, 401, { error: "session expired" });
        return json(res, 500, { error: e?.message || String(e) });
      }
    }

    // ---- saved delivery addresses (for the picker) ----
    if (path === "/api/addresses") {
      const server = url.searchParams.get("server") || "food";
      const provider = new FileOAuthProvider(server);
      if (!provider.tokens()) return json(res, 401, { error: "not connected" });
      try {
        return json(res, 200, { addresses: await listAddresses({ server }) });
      } catch (e) {
        return json(res, 500, { error: e?.message || String(e) });
      }
    }

    // ---- order: stage (adds to REAL cart, returns the REAL bill) ----
    if (path === "/api/order/stage" && req.method === "POST") {
      const b = await readBody(req);
      console.log(`  [${stamp()}] STAGE ${b.server}/${b.restaurantId} ${(b.items || []).length} items`);
      try {
        return json(res, 200, { ok: true, ...(await stageOrder(b)) });
      } catch (e) {
        return json(res, 500, { error: e?.message || String(e) });
      }
    }

    // ---- order: place (REAL order, COD) ----
    if (path === "/api/order/place" && req.method === "POST") {
      const b = await readBody(req);
      console.log(`  [${stamp()}] PLACE ORDER ${b.server} addr=${b.addressId}`);
      try {
        return json(res, 200, { ok: true, ...(await placeOrder(b)) });
      } catch (e) {
        return json(res, 500, { error: e?.message || String(e) });
      }
    }

    // ---- order: cancel (flush the staged cart) ----
    if (path === "/api/order/cancel" && req.method === "POST") {
      const b = await readBody(req);
      try {
        return json(res, 200, { ok: true, ...(await cancelOrder(b)) });
      } catch (e) {
        return json(res, 500, { error: e?.message || String(e) });
      }
    }

    // ---- LIVE mission (SSE) ----
    if (path === "/api/feast") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const emit = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      const server = url.searchParams.get("server") || "food";
      const query = url.searchParams.get("q") || "surprise me";
      const budget = +(url.searchParams.get("budget") || 800);
      const addressId = url.searchParams.get("addressId") || undefined;
      const veg = +(url.searchParams.get("veg") || 0);
      try {
        emit({ type: "log", msg: `opening LIVE channel // Swiggy ${server.toUpperCase()} MCP...`, cls: "sys" });
        const ok = await runLiveMission({ server, query, budget, addressId, veg, emit });
        if (!ok) emit({ type: "fallback" });
      } catch (e) {
        emit({ type: "error", msg: e?.message || String(e) });
        emit({ type: "fallback" });
      }
      return res.end();
    }

    await serveStatic(req, res);
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: e?.message || String(e) });
    else res.end();
  }
});

function page(title, msg, ok) {
  const c = ok ? "#57e39b" : "#ff3b57";
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
  <body style="margin:0;height:100vh;display:grid;place-items:center;background:#0d0710;color:#f4ecf5;font-family:system-ui">
  <div style="text-align:center;padding:2rem">
    <div style="font-size:3rem">${ok ? "OK" : "X"}</div>
    <h2 style="color:${c};letter-spacing:.05em">${title}</h2>
    <p style="color:#9a8aa6;font-family:ui-monospace,monospace">${msg}</p>
  </div>
  <script>try{window.opener&&window.opener.postMessage({feastmodeAuth:${ok}},"*")}catch(e){}; setTimeout(()=>{try{window.close()}catch(e){}}, ${ok ? 1400 : 6000});</script>
  </body>`;
}

server.listen(PORT, () => {
  console.log(`\n  FEASTMODE running -> http://localhost:${PORT}`);
  console.log(`  DEMO works instantly. Click "CONNECT SWIGGY" in the UI for LIVE.\n`);
});
