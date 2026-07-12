// File-backed OAuth 2.1 + PKCE provider for the Swiggy MCP servers.
// Persists dynamically-registered client info + tokens + PKCE verifier to disk
// so you authenticate once and reuse the ~5-day session across runs.

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const STORE_DIR = join(__dir, "..", ".swiggy");

// The three official Swiggy MCP servers. All share one auth server
// (https://mcp.swiggy.com/auth); the resource indicator differs per URL.
export const SERVERS = {
  food: "https://mcp.swiggy.com/food",
  instamart: "https://mcp.swiggy.com/im",
  dineout: "https://mcp.swiggy.com/dineout",
};

// Must be a whitelisted redirect URI. localhost is whitelisted by Swiggy.
export const REDIRECT_URL = "http://localhost:8765/callback";
export const CALLBACK_PORT = 8765;

const SCOPES = "mcp:tools mcp:resources mcp:prompts";

function load(server) {
  const f = join(STORE_DIR, `${server}.json`);
  if (!existsSync(f)) return {};
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return {};
  }
}

function save(server, data) {
  mkdirSync(STORE_DIR, { recursive: true });
  writeFileSync(join(STORE_DIR, `${server}.json`), JSON.stringify(data, null, 2));
}

export function clearSession(server) {
  const f = join(STORE_DIR, `${server}.json`);
  if (existsSync(f)) rmSync(f);
}

export class FileOAuthProvider {
  constructor(server) {
    this.server = server;
    this._data = load(server); // { clientInformation, tokens, codeVerifier }
  }

  get redirectUrl() {
    return REDIRECT_URL;
  }

  get clientMetadata() {
    return {
      client_name: "swiggy-mcp-toy",
      redirect_uris: [REDIRECT_URL],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none", // public client (server supports "none")
      scope: SCOPES,
    };
  }

  clientInformation() {
    return this._data.clientInformation;
  }

  saveClientInformation(info) {
    this._data.clientInformation = info;
    save(this.server, this._data);
  }

  tokens() {
    return this._data.tokens;
  }

  saveTokens(tokens) {
    this._data.tokens = tokens;
    save(this.server, this._data);
  }

  saveCodeVerifier(verifier) {
    this._data.codeVerifier = verifier;
    save(this.server, this._data);
  }

  codeVerifier() {
    if (!this._data.codeVerifier) throw new Error("No PKCE code verifier saved");
    return this._data.codeVerifier;
  }

  // Set by the login script so it can open the browser + capture the code.
  redirectToAuthorization(authorizationUrl) {
    if (this._onRedirect) this._onRedirect(authorizationUrl);
  }

  invalidateCredentials(scope) {
    if (scope === "all") this._data = {};
    else delete this._data[scope === "tokens" ? "tokens" : scope === "verifier" ? "codeVerifier" : "clientInformation"];
    save(this.server, this._data);
  }
}
