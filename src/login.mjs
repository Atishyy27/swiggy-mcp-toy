// Interactive OAuth login for a Swiggy MCP server.
// Usage: node src/login.mjs [food|instamart|dineout]   (default: food)
//
// Flow: start a localhost callback server -> connect (triggers OAuth) ->
// open browser -> you sign in with phone + OTP -> Swiggy redirects back with
// a code -> exchange it for a ~5-day token, saved to .swiggy/<server>.json.

import http from "node:http";
import open from "open";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { FileOAuthProvider, SERVERS, CALLBACK_PORT } from "./oauth-provider.mjs";

const server = (process.argv[2] || "food").toLowerCase();
const url = SERVERS[server];
if (!url) {
  console.error(`Unknown server "${server}". Choose: ${Object.keys(SERVERS).join(", ")}`);
  process.exit(1);
}

function waitForCallback() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, `http://localhost:${CALLBACK_PORT}`);
      if (u.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const code = u.searchParams.get("code");
      const err = u.searchParams.get("error");
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        `<html><body style="font-family:system-ui;padding:3rem;text-align:center">
         <h2>${code ? "✅ Swiggy MCP connected" : "❌ Authorization failed"}</h2>
         <p>${code ? "You can close this tab and return to the terminal." : err || "No code returned."}</p>
         </body></html>`
      );
      srv.close();
      if (code) resolve(code);
      else reject(new Error(`OAuth error: ${err || "no code"}`));
    });
    srv.listen(CALLBACK_PORT, () => console.log(`↳ Listening for OAuth callback on http://localhost:${CALLBACK_PORT}`));
    srv.on("error", reject);
  });
}

async function main() {
  const provider = new FileOAuthProvider(server);

  // Fast path: already have a valid session.
  if (provider.tokens()) {
    console.log(`Existing session found for "${server}". Verifying...`);
  }

  provider._onRedirect = (authUrl) => {
    console.log("\n🔐 Opening Swiggy login in your browser (sign in with phone + OTP)...");
    console.log(`   If it doesn't open, paste this:\n   ${authUrl}\n`);
    open(authUrl.toString()).catch(() => {});
  };

  const transport = new StreamableHTTPClientTransport(new URL(url), { authProvider: provider });
  const client = new Client({ name: "swiggy-mcp-toy", version: "0.1.0" }, { capabilities: {} });

  try {
    await client.connect(transport);
    console.log(`\n✅ Connected to Swiggy ${server} MCP — session already valid.`);
    await client.close();
    return;
  } catch (e) {
    if (!(e instanceof UnauthorizedError)) throw e;
  }

  // Needed interactive auth: wait for the browser redirect, then finish.
  const code = await waitForCallback();
  await transport.finishAuth(code);
  console.log("✅ Token exchanged and saved to .swiggy/" + server + ".json");

  // Reconnect with the fresh token to confirm it works.
  const t2 = new StreamableHTTPClientTransport(new URL(url), { authProvider: new FileOAuthProvider(server) });
  const c2 = new Client({ name: "swiggy-mcp-toy", version: "0.1.0" }, { capabilities: {} });
  await c2.connect(t2);
  console.log(`✅ Verified: connected to Swiggy ${server} MCP.`);
  await c2.close();
}

main().catch((e) => {
  console.error("\n✖ Login failed:", e?.message || e);
  process.exit(1);
});
