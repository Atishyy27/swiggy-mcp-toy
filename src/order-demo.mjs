// Adaptive demo: connect to the Food server, discover its real tools, run a
// restaurant search, and STOP before placing any order (safety first).
// It matches tools by name/description so it works regardless of exact schema.
//
// Usage: node src/order-demo.mjs "biryani"     (default query: "pizza")
// Run `node src/login.mjs food` first.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { FileOAuthProvider, SERVERS } from "./oauth-provider.mjs";

const query = process.argv[2] || "pizza";

const provider = new FileOAuthProvider("food");
if (!provider.tokens()) {
  console.log("⚠  No session. Run:  node src/login.mjs food");
  process.exit(1);
}

const transport = new StreamableHTTPClientTransport(new URL(SERVERS.food), { authProvider: provider });
const client = new Client({ name: "swiggy-mcp-toy", version: "0.1.0" }, { capabilities: {} });

try {
  await client.connect(transport);
} catch (e) {
  if (e instanceof UnauthorizedError) {
    console.log("⚠  Session expired. Re-run:  node src/login.mjs food");
    process.exit(1);
  }
  throw e;
}

const { tools } = await client.listTools();
const byHint = (...hints) =>
  tools.find((t) => hints.every((h) => (t.name + " " + (t.description || "")).toLowerCase().includes(h)));

// Discover the search tool without hard-coding its exact name.
const searchTool =
  byHint("search", "restaurant") || byHint("restaurant") || byHint("search");

if (!searchTool) {
  console.log("Available tools:", tools.map((t) => t.name).join(", "));
  console.log("\nCould not auto-detect a search tool — inspect the list above and adjust.");
  await client.close();
  process.exit(0);
}

console.log(`Using tool "${searchTool.name}" to search for: ${query}\n`);
const argName =
  Object.keys(searchTool.inputSchema?.properties || {}).find((k) =>
    ["query", "q", "search", "keyword", "term", "text"].includes(k.toLowerCase())
  ) || Object.keys(searchTool.inputSchema?.properties || {})[0];

const res = await client.callTool({
  name: searchTool.name,
  arguments: argName ? { [argName]: query } : {},
});

for (const c of res.content || []) {
  if (c.type === "text") console.log(c.text.slice(0, 2000));
}

console.log(
  "\n— Stopping here on purpose. This demo does NOT place an order.\n" +
    "  Cart/order tools discovered:",
  tools
    .filter((t) => /cart|order|checkout/i.test(t.name))
    .map((t) => t.name)
    .join(", ") || "(none matched)"
);
await client.close();
