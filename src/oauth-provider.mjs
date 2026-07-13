// OAuth 2.1 + PKCE providers for the Swiggy MCP servers.
//
// Two stores, same interface:
//   FileOAuthProvider    - persists to .swiggy/<server>.json. Single user, local
//                          machine. This is what login.mjs / list-tools.mjs /
//                          order-demo.mjs use, and what the UI uses locally.
//   SessionOAuthProvider - keeps everything in memory, keyed by a browser session
//                          id. Required for any PUBLIC deploy: the file store is
//                          global, so on a shared server visitor #2 would inherit
//                          visitor #1's Swiggy account and could order to their
//                          address. Nothing about a token is safe to share.

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

const __dir = dirname(fileURLToPath(import.meta.url));
const STORE_DIR = join(__dir, "..", ".swiggy");

// The three official Swiggy MCP servers. All share one auth server
// (https://mcp.swiggy.com/auth); the resource indicator differs per URL.
export const SERVERS = {
  food: "https://mcp.swiggy.com/food",
  instamart: "https://mcp.swiggy.com/im",
  dineout: "https://mcp.swiggy.com/dineout",
};

// Multi-user public deploy (Render). Off by default so the local flow is untouched.
export const PUBLIC_MODE = process.env.FEASTMODE_PUBLIC === "1";

// Must be a whitelisted redirect URI. localhost is whitelisted by Swiggy.
export const REDIRECT_URL = "http://localhost:8765/callback";
export const CALLBACK_PORT = 8765;

// On a deployed box the browser cannot be sent back to localhost, so the redirect
// has to be the public origin, e.g. https://feastmode.onrender.com/oauth/callback.
// UNVERIFIED ASSUMPTION: Swiggy almost certainly validates redirect_uri against a
// whitelist registered with them. If this exact origin is not whitelisted, the
// authorization request will be rejected and no amount of code here fixes it.
export const PUBLIC_ORIGIN = (process.env.PUBLIC_ORIGIN || "").replace(/\/+$/, "");
export const PUBLIC_REDIRECT_URL = PUBLIC_ORIGIN ? `${PUBLIC_ORIGIN}/oauth/callback` : "";

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

// Shared OAuthClientProvider behaviour. Subclasses only supply the storage.
class BaseOAuthProvider {
  constructor(server, opts = {}) {
    this.server = server;
    this._redirect = opts.redirectUrl || REDIRECT_URL;
  }

  // What we register with the auth server at dynamic-registration time.
  get registeredRedirects() {
    return [REDIRECT_URL];
  }

  get redirectUrl() {
    return this._redirect;
  }

  get clientMetadata() {
    return {
      client_name: "swiggy-mcp-toy",
      redirect_uris: this.registeredRedirects,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none", // public client (server supports "none")
      scope: SCOPES,
    };
  }

  _read() { throw new Error("not implemented"); }
  _write(_data) { throw new Error("not implemented"); }

  clientInformation() {
    return this._read().clientInformation;
  }

  saveClientInformation(info) {
    const d = this._read();
    d.clientInformation = info;
    this._write(d);
  }

  tokens() {
    return this._read().tokens;
  }

  saveTokens(tokens) {
    const d = this._read();
    d.tokens = tokens;
    this._write(d);
  }

  saveCodeVerifier(verifier) {
    const d = this._read();
    d.codeVerifier = verifier;
    this._write(d);
  }

  codeVerifier() {
    const v = this._read().codeVerifier;
    if (!v) throw new Error("No PKCE code verifier saved");
    return v;
  }

  // Set by the caller so it can open the browser + capture the code.
  redirectToAuthorization(authorizationUrl) {
    if (this._onRedirect) this._onRedirect(authorizationUrl);
  }

  invalidateCredentials(scope) {
    if (scope === "all") return this._write({});
    const d = this._read();
    delete d[scope === "tokens" ? "tokens" : scope === "verifier" ? "codeVerifier" : "clientInformation"];
    this._write(d);
  }
}

export class FileOAuthProvider extends BaseOAuthProvider {
  constructor(server, opts = {}) {
    super(server, opts);
    this._data = load(server); // { clientInformation, tokens, codeVerifier }
  }

  _read() { return this._data; }

  _write(data) {
    this._data = data;
    save(this.server, data);
  }
}

// ---------------------------------------------------------------------------
// In-memory, session-scoped store. One Map, keyed by the fm_sid cookie value.
// ---------------------------------------------------------------------------

export const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // idle sessions die after 2h
const STATE_TTL_MS = 15 * 60 * 1000;              // an in-flight OAuth hop is short

const sessions = new Map();   // sid -> { at, stores: Map<server, data> }
const authStates = new Map(); // oauth state -> { sid, server, at }

export const newSessionId = () => randomBytes(32).toString("hex");

export function touchSession(sid) {
  let s = sessions.get(sid);
  if (!s) sessions.set(sid, (s = { stores: new Map() }));
  s.at = Date.now();
  return s;
}

export const hasSession = (sid) => sessions.has(sid);
export const dropSession = (sid) => sessions.delete(sid);
export const sessionCount = () => sessions.size;

// Log out one vertical without nuking the whole session.
export function clearSessionServer(sid, server) {
  sessions.get(sid)?.stores.delete(server);
}

// The OAuth `state` is the only thing that survives the round trip through
// Swiggy, so it is how the callback finds the session that owns the PKCE
// verifier. Cookies may or may not ride along on a cross-site redirect.
export function rememberAuthState(state, sid, server) {
  authStates.set(state, { sid, server, at: Date.now() });
}

export function lookupAuthState(state) {
  if (!state) return null;
  const e = authStates.get(state);
  if (!e) return null;
  authStates.delete(state); // single use
  if (Date.now() - e.at > STATE_TTL_MS) return null;
  return e;
}

export function sweepSessions(ttl = SESSION_TTL_MS) {
  const now = Date.now();
  let dropped = 0;
  for (const [sid, s] of sessions) {
    if (now - s.at > ttl) { sessions.delete(sid); dropped++; }
  }
  for (const [st, e] of authStates) {
    if (now - e.at > STATE_TTL_MS) authStates.delete(st);
  }
  return dropped;
}

export class SessionOAuthProvider extends BaseOAuthProvider {
  constructor(sid, server, opts = {}) {
    super(server, opts);
    this.sid = sid;
  }

  // A session provider only ever redirects to the origin it is actually served
  // from, so that is what it registers.
  get registeredRedirects() {
    return [this._redirect];
  }

  _slot() {
    const s = touchSession(this.sid);
    let d = s.stores.get(this.server);
    if (!d) s.stores.set(this.server, (d = {}));
    return d;
  }

  _read() { return this._slot(); }

  _write(data) {
    touchSession(this.sid).stores.set(this.server, data);
  }

  // Called by the SDK when it starts a fresh authorization flow.
  state() {
    const st = randomBytes(16).toString("hex");
    rememberAuthState(st, this.sid, this.server);
    return st;
  }
}
