/** Stateless Streamable HTTP transport; no database or production wiring here. */
import express, { type ErrorRequestHandler, type Express, type RequestHandler } from "express";
import { createVoiceFleetMcp, SUPPORTED } from "../../connectors/voice-fleet-mcp/core.mjs";
import { resolveAppDomain } from "../config/environment";
import { verifyStoredToken, type PluginStore } from "./store";
import { parseBearerToken } from "./tokens";

export const VOICE_FLEET_MCP_PATH = "/api/plugin/v1/mcp";

/** Keep MCP raw until its own authentication and 1 MB parser have run. */
export function pluginAwareBodyParsers(): RequestHandler {
  const parsers = express.Router();
  parsers.use(express.json(), express.urlencoded({ extended: true }));
  return (req, res, next) => {
    if (/^\/api\/plugin\/v1\/mcp\/?$/i.test(req.path)) return next();
    parsers(req, res, next);
  };
}

interface McpRouteDeps {
  store: PluginStore;
  env?: Record<string, string | undefined>;
  now?: () => Date;
}

function envelopeKind(message: unknown): "request" | "ignored" | "invalid" {
  if (!message || typeof message !== "object" || Array.isArray(message)) return "invalid";
  const item = message as Record<string, unknown>;
  if (item.jsonrpc !== "2.0") return "invalid";
  const owns = (key: string) => Object.prototype.hasOwnProperty.call(item, key);
  if (!owns("method")) return owns("result") || owns("error") ? "ignored" : "invalid";
  if (typeof item.method !== "string") return "invalid";
  if (!owns("id")) return "ignored";
  return typeof item.id === "string" || (typeof item.id === "number" && Number.isFinite(item.id))
    ? "request" : "invalid";
}

export function mountVoiceFleetMcp(app: Express, deps: McpRouteDeps): void {
  const env = deps.env ?? process.env;
  const parseBody = express.raw({ type: () => true, limit: "1mb", inflate: false });
  const errorReply = (code: number, message: string) => ({ jsonrpc: "2.0", id: null, error: { code, message } });
  const allowedOrigins = new Set((env.VOICE_FLEET_MCP_ALLOWED_ORIGINS || "").split(",").map((origin) => origin.trim()).filter(Boolean));
  const replitDomains = env.REPLIT_DOMAINS || "";
  const publicDomain = resolveAppDomain({
    domain: env.DOMAIN, replitDomains, replitDevDomain: env.REPLIT_DEV_DOMAIN,
    isProduction: env.REPLIT_DEPLOYMENT === "1" || (replitDomains.includes(".replit.app") && !replitDomains.includes(".replit.dev")),
  });
  if (publicDomain.source !== "fallback") {
    try {
      const url = new URL(publicDomain.domain.includes("://") ? publicDomain.domain : `https://${publicDomain.domain}`);
      if (url.protocol === "https:" || url.protocol === "http:") allowedOrigins.add(url.origin);
    } catch { /* A malformed configured domain must not grant an origin. */ }
  }

  const requireAuth: RequestHandler = async (req, res, next) => {
    const parsed = parseBearerToken(req.headers.authorization);
    if (!parsed || !await verifyStoredToken(deps.store, parsed, deps.now?.() ?? new Date())) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="voice-fleet-mcp"');
      res.status(401).json({ error: "Missing or invalid Bearer token" });
      return;
    }
    next();
  };

  const postOnly: RequestHandler = (req, res, next) => {
    if (req.method === "POST") return next();
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method not allowed" });
  };

  const requireAllowedOrigin: RequestHandler = (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    const origin = req.get("Origin");
    if (req.method === "POST" && origin !== undefined && !allowedOrigins.has(origin)) {
      res.status(403).json({ error: "Origin not allowed" });
      return;
    }
    next();
  };

  const requireProtocolVersion: RequestHandler = (req, res, next) => {
    const version = req.get("MCP-Protocol-Version");
    if (version !== undefined && !SUPPORTED.some((supported) => supported === version)) {
      res.status(400).json(errorReply(-32600, "Unsupported MCP protocol version"));
      return;
    }
    next();
  };

  const handle: RequestHandler = async (req, res) => {
    let message: unknown;
    try {
      message = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "");
    } catch {
      res.status(400).json(errorReply(-32700, "Parse error"));
      return;
    }
    const core = createVoiceFleetMcp({
      baseUrl: env.VOICE_FLEET_MCP_INTERNAL_BASE_URL || `http://127.0.0.1:${Number(env.API_PORT) || 5000}`,
      // Use the exact caller credential, never the stdio token file or proxy headers.
      getToken: () => req.headers.authorization!.match(/^Bearer\s+(\S+)\s*$/i)![1],
      timeoutMs: Number(env.VOICE_FLEET_TIMEOUT_MS || 30000),
    });
    if (Array.isArray(message)) {
      if (message.length === 0) {
        res.status(400).json(errorReply(-32600, "Invalid Request"));
        return;
      }
      // 2025-06-18 removed batching; accept it leniently for older clients.
      // Sequential dispatch preserves both response order and prepare/commit ordering.
      const replies = [];
      for (const item of message) {
        const kind = envelopeKind(item);
        if (kind === "invalid") {
          replies.push(errorReply(-32600, "Invalid Request"));
          continue;
        }
        if (kind === "ignored") continue;
        const reply = await core.handleMessage(item);
        if (reply !== null) replies.push(reply);
      }
      if (replies.length) res.json(replies);
      else res.status(202).end();
      return;
    }
    const kind = envelopeKind(message);
    if (kind === "invalid") {
      res.status(400).json(errorReply(-32600, "Invalid Request"));
      return;
    }
    if (kind === "ignored") {
      res.status(202).end();
      return;
    }
    const reply = await core.handleMessage(message);
    if (reply === null) res.status(202).end();
    else res.json(reply);
  };

  const parserError: ErrorRequestHandler = (error, _req, res, _next) => {
    // Do not pass parser errors to a logger: they can contain the request body.
    if (error.type === "entity.too.large") {
      res.status(413).json(errorReply(-32600, "Request body exceeds 1 MB"));
    } else if (["entity.parse.failed", "request.aborted", "request.size.invalid", "encoding.unsupported", "charset.unsupported"].includes(error.type)) {
      res.status(400).json(errorReply(-32700, "Parse error"));
    } else {
      res.status(500).json(errorReply(-32603, "Internal error"));
    }
  };

  app.all(VOICE_FLEET_MCP_PATH, requireAllowedOrigin, requireAuth, postOnly, requireProtocolVersion, parseBody, handle, parserError);
}
