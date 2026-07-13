// FEASTMODE server: serves the UI, runs the full Swiggy MCP OAuth flow in the
// browser (one button, popup login, backend catches the callback), streams LIVE
// missions over SSE, and exposes the real live tool catalog. No external deps.
//
// Usage: node server.mjs   then open http://localhost:3000
// Click "CONNECT SWIGGY" in the UI - no terminal login needed.
//
// Two modes:
//   default            single user, tokens in .swiggy/<server>.json. Atishay's box.
//   FEASTMODE_PUBLIC=1 many strangers, tokens in memory per browser session, and
//                      placing a real order is hard-disabled. See /api/health.

import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname, normalize } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  FileOAuthProvider, SessionOAuthProvider, SERVERS, clearSession,
  PUBLIC_MODE, PUBLIC_REDIRECT_URL, SESSION_TTL_MS,
  newSessionId, touchSession, clearSessionServer, lookupAuthState, sweepSessions, sessionCount,
} from "./src/oauth-provider.mjs";
import { runLiveMission, listAddresses, stageOrder, placeOrder, cancelOrder } from "./src/agent.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dir, "public");
const PORT = process.env.PORT || 3000;

// Where Swiggy sends the browser back. On Render this MUST be the public origin;
// see the PUBLIC_ORIGIN note in src/oauth-provider.mjs (whitelist assumption).
const WEB_REDIRECT = PUBLIC_REDIRECT_URL || `http://localhost:${PORT}/oauth/callback`;

// Which vertical a session is mid-login on. Keyed by session so two visitors
// authenticating at once cannot finish each other's flow.
const pendingAuth = new Map(); // sid -> server

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

// ---- sessions -------------------------------------------------------------

const COOKIE = "fm_sid";

function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return "";
}

// Render terminates TLS in front of us, so the socket is plain http; the proxy
// header is the only way to know the browser is on https.
const isHttps = (req) =>
  (req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https" || !!req.socket.encrypted;

// Resolve the caller's session, minting one on first contact. Cookie is set with
// setHeader so it survives every later writeHead (JSON, SSE, static, callback).
function resolveSession(req, res) {
  let sid = readCookie(req, COOKIE);
  if (!/^[0-9a-f]{64}$/.test(sid)) {
    sid = newSessionId();
    const attrs = [`${COOKIE}=${sid}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${SESSION_TTL_MS / 1000}`];
    if (isHttps(req)) attrs.push("Secure");
    res.setHeader("set-cookie", attrs.join("; "));
  }
  touchSession(sid);
  return sid;
}

// The one switch that decides whose tokens these are.
const providerFor = (sid, server, redirectUrl) =>
  PUBLIC_MODE
    ? new SessionOAuthProvider(sid, server, redirectUrl ? { redirectUrl } : {})
    : new FileOAuthProvider(server, redirectUrl ? { redirectUrl } : {});

function newClient(sid, server, redirectUrl) {
  const provider = providerFor(sid, server, redirectUrl);
  const transport = new StreamableHTTPClientTransport(new URL(SERVERS[server]), { authProvider: provider });
  const client = new Client({ name: "feastmode", version: "0.1.0" }, { capabilities: {} });
  return { provider, transport, client };
}

setInterval(() => {
  const n = sweepSessions();
  if (n) console.log(`  [${stamp()}] swept ${n} idle session(s), ${sessionCount()} live`);
}, 10 * 60 * 1000).unref();

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
    const sid = resolveSession(req, res);

    if (path === "/api/health") return json(res, 200, { ok: true, mode: "feastmode", public: PUBLIC_MODE });

    // ---- auth: status ----
    if (path === "/api/auth/status") {
      const server = url.searchParams.get("server") || "food";
      const provider = providerFor(sid, server);
      return json(res, 200, { server, connected: !!provider.tokens() });
    }

    // ---- auth: start (returns the Swiggy login URL for a popup) ----
    if (path === "/api/auth/start") {
      const server = url.searchParams.get("server") || "food";
      if (!SERVERS[server]) return json(res, 400, { error: "unknown server" });
      const { provider, transport, client } = newClient(sid, server, WEB_REDIRECT);
      if (provider.tokens()) return json(res, 200, { connected: true });
      let authUrl;
      provider._onRedirect = (u) => (authUrl = u);
      try {
        await client.connect(transport);
        return json(res, 200, { connected: true }); // token was already valid
      } catch (e) {
        if (!(e instanceof UnauthorizedError)) throw e;
      }
      pendingAuth.set(sid, server);
      return json(res, 200, { connected: false, url: authUrl.toString() });
    }

    // ---- auth: OAuth redirect target ----
    // The PKCE verifier lives in ONE session, so this hop has to land back in that
    // same session. `state` is minted by SessionOAuthProvider and carries the sid
    // through Swiggy; the cookie is only a fallback (a cross-site redirect is a
    // top-level GET, so SameSite=Lax usually sends it, but "usually" is not a plan).
    if (path === "/oauth/callback") {
      const code = url.searchParams.get("code");
      const err = url.searchParams.get("error");
      const st = lookupAuthState(url.searchParams.get("state"));
      const owner = st?.sid || sid;
      const server = st?.server || pendingAuth.get(owner) || "food";
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      if (!code) {
        res.end(page("Authorization failed", err || "no code returned", false));
        return;
      }
      try {
        const { transport } = newClient(owner, server, WEB_REDIRECT);
        await transport.finishAuth(code);
        pendingAuth.delete(owner);
        res.end(page("Connected", `Swiggy ${server.toUpperCase()} MCP is linked. Close this tab.`, true));
      } catch (e) {
        res.end(page("Token exchange failed", e?.message || String(e), false));
      }
      return;
    }

    // ---- auth: disconnect ----
    if (path === "/api/auth/logout") {
      const server = url.searchParams.get("server") || "food";
      if (PUBLIC_MODE) clearSessionServer(sid, server);
      else clearSession(server);
      return json(res, 200, { ok: true });
    }

    // ---- live tool catalog ----
    if (path === "/api/tools") {
      const server = url.searchParams.get("server") || "food";
      const { provider, transport, client } = newClient(sid, server);
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
      const auth = providerFor(sid, server);
      if (!auth.tokens()) return json(res, 401, { error: "not connected" });
      try {
        return json(res, 200, { addresses: await listAddresses({ server, auth }) });
      } catch (e) {
        return json(res, 500, { error: e?.message || String(e) });
      }
    }

    // ---- order: stage (adds to REAL cart, returns the REAL bill) ----
    // Allowed in public mode: it only touches the visitor's OWN cart, and cancel
    // undoes it. No money moves.
    if (path === "/api/order/stage" && req.method === "POST") {
      const b = await readBody(req);
      console.log(`  [${stamp()}] STAGE ${b.server}/${b.restaurantId} ${(b.items || []).length} items`);
      try {
        return json(res, 200, { ok: true, ...(await stageOrder({ ...b, auth: providerFor(sid, b.server || "food") })) });
      } catch (e) {
        return json(res, 500, { error: e?.message || String(e) });
      }
    }

    // ---- order: place (REAL order, COD) ----
    // Hard-disabled on the public deploy, before any MCP call: this would spend a
    // stranger's money on a stranger's card at a stranger's address.
    if (path === "/api/order/place" && req.method === "POST") {
      if (PUBLIC_MODE) {
        return json(res, 403, {
          error: "ordering is disabled on the public demo",
          detail: "This deploy can stage a real cart and price it for real, but it will never place an order. Run it locally to actually buy food.",
          public: true,
        });
      }
      const b = await readBody(req);
      console.log(`  [${stamp()}] PLACE ORDER ${b.server} addr=${b.addressId}`);
      try {
        return json(res, 200, { ok: true, ...(await placeOrder({ ...b, auth: providerFor(sid, b.server || "food") })) });
      } catch (e) {
        return json(res, 500, { error: e?.message || String(e) });
      }
    }

    // ---- order: cancel (flush the staged cart) ----
    if (path === "/api/order/cancel" && req.method === "POST") {
      const b = await readBody(req);
      try {
        return json(res, 200, { ok: true, ...(await cancelOrder({ ...b, auth: providerFor(sid, b.server || "food") })) });
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
        const ok = await runLiveMission({ server, query, budget, addressId, veg, emit, auth: providerFor(sid, server) });
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
  if (PUBLIC_MODE) {
    console.log(`  PUBLIC mode // tokens are per-session and in-memory, ordering is DISABLED`);
    console.log(`  OAuth redirect -> ${WEB_REDIRECT}${PUBLIC_REDIRECT_URL ? "" : "  (set PUBLIC_ORIGIN!)"}\n`);
  } else {
    console.log(`  DEMO works instantly. Click "CONNECT SWIGGY" in the UI for LIVE.\n`);
  }
});
