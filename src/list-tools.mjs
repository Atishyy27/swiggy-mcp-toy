// Connect to a Swiggy MCP server with a saved session and dump the live
// tool / resource / prompt catalog — the ground-truth schemas the public
// docs don't publish. Writes schema.<server>.json next to the scripts.
//
// Usage: node src/list-tools.mjs [food|instamart|dineout|all]   (default: food)
// Run `node src/login.mjs <server>` first.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { FileOAuthProvider, SERVERS } from "./oauth-provider.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));

async function dump(server) {
  const url = SERVERS[server];
  const provider = new FileOAuthProvider(server);
  if (!provider.tokens()) {
    console.log(`\n⚠  No session for "${server}". Run:  node src/login.mjs ${server}`);
    return;
  }

  const transport = new StreamableHTTPClientTransport(new URL(url), { authProvider: provider });
  const client = new Client({ name: "swiggy-mcp-toy", version: "0.1.0" }, { capabilities: {} });

  try {
    await client.connect(transport);
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      console.log(`\n⚠  Session for "${server}" expired. Re-run:  node src/login.mjs ${server}`);
      return;
    }
    throw e;
  }

  const caps = client.getServerCapabilities() || {};
  const out = { server, url, tools: [], resources: [], prompts: [] };

  const tools = await client.listTools();
  out.tools = tools.tools;
  console.log(`\n━━ Swiggy ${server.toUpperCase()} (${url}) — ${tools.tools.length} tools ━━`);
  for (const t of tools.tools) {
    const params = Object.keys(t.inputSchema?.properties || {});
    const required = new Set(t.inputSchema?.required || []);
    const sig = params.map((p) => (required.has(p) ? p : `${p}?`)).join(", ");
    console.log(`\n• ${t.name}(${sig})`);
    if (t.description) console.log(`    ${t.description.split("\n")[0]}`);
  }

  if (caps.resources) {
    try {
      out.resources = (await client.listResources()).resources;
      console.log(`\n  resources: ${out.resources.length}`);
    } catch {}
  }
  if (caps.prompts) {
    try {
      out.prompts = (await client.listPrompts()).prompts;
      console.log(`  prompts: ${out.prompts.length}`);
    } catch {}
  }

  const file = join(__dir, "..", `schema.${server}.json`);
  writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\n💾 Full schemas written to ${file}`);
  await client.close();
}

const arg = (process.argv[2] || "food").toLowerCase();
const targets = arg === "all" ? Object.keys(SERVERS) : [arg];
for (const s of targets) {
  if (!SERVERS[s]) {
    console.error(`Unknown server "${s}". Choose: ${Object.keys(SERVERS).join(", ")}, all`);
    continue;
  }
  await dump(s);
}
