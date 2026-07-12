// FEASTMODE server: serves the UI and streams a LIVE mission from the real
// Swiggy Food MCP over Server-Sent Events. No external deps (plain http).
//
// Usage: node server.mjs   then open http://localhost:3000
// LIVE mode needs a Swiggy session: run `node src/login.mjs food` first.

import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname, normalize } from "node:path";
import { runLiveMission } from "./src/agent.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dir, "public");
const PORT = process.env.PORT || 3000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

async function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p === "/") p = "/index.html";
  const file = normalize(join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");

  if (url.pathname === "/api/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, mode: "feastmode" }));
    return;
  }

  if (url.pathname === "/api/feast") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const emit = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const query = url.searchParams.get("q") || "surprise me";
    const budget = +(url.searchParams.get("budget") || 800);

    try {
      emit({ type: "log", msg: "opening LIVE channel to Swiggy MCP...", cls: "sys" });
      const ok = await runLiveMission({ query, budget, emit });
      if (!ok) emit({ type: "fallback" }); // tell the UI to run the simulation
    } catch (e) {
      emit({ type: "error", msg: e?.message || String(e) });
      emit({ type: "fallback" });
    }
    res.end();
    return;
  }

  await serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`\n  FEASTMODE running -> http://localhost:${PORT}`);
  console.log(`  DEMO works instantly. For LIVE: node src/login.mjs food\n`);
});
