import express from "express";
import { createServer } from "http";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

console.log("[PRODUCTION] Starting combined server...");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env.PORT || "5000", 10);
const DOMAIN = process.env.DOMAIN || "localhost";

console.log(`[PRODUCTION] PORT=${PORT}, DOMAIN=${DOMAIN}`);

const app = express();
const server = createServer(app);

app.get("/healthz", (_req, res) => {
  res.status(200).send("OK");
});

app.get("/", (_req, res, next) => {
  if (!isReady) {
    res.status(200).send("Starting up...");
    return;
  }
  next();
});

let isReady = false;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[PRODUCTION] ✓ Server listening on port ${PORT}`);
  initializeApp().catch((err) => {
    console.error("[PRODUCTION] Initialization failed:", err);
  });
});

server.on("error", (err: NodeJS.ErrnoException) => {
  console.error(`[PRODUCTION] Fatal: Cannot bind to port ${PORT}:`, err.message);
  process.exit(1);
});

async function initializeApp() {
  const PORT_8000 = 8000;
  if (PORT !== PORT_8000) {
    const server8000 = createServer(app);
    server8000.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        console.log(`[PRODUCTION] Port ${PORT_8000} already in use, skipping secondary binding`);
      } else {
        console.error(`[PRODUCTION] Error binding to port ${PORT_8000}:`, err);
      }
    });
    server8000.listen(PORT_8000, "0.0.0.0", () => {
      console.log(`[PRODUCTION] Also listening on port ${PORT_8000} for Twilio webhooks`);
    });
  }

  try {
    app.use("/api/voice", express.raw({ type: "*/*" }));

    console.log("[PRODUCTION] Initializing agent registry...");
    const { agentRegistry } = await import("../src/config/agents");
    const agentCount = agentRegistry.getAllAgents().length;
    console.log(`[PRODUCTION] Agent registry initialized: ${agentCount} agents registered`);

    console.log("[PRODUCTION] Loading Voice Agent routes...");
    const { setupVoiceAgentRoutes } = await import("../src/voiceAgentRoutes");
    setupVoiceAgentRoutes(app);
    console.log("[PRODUCTION] Voice Agent routes loaded");

    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    console.log("[PRODUCTION] Loading API routes...");
    const { registerRoutes } = await import("./routes");
    await registerRoutes(app);
    console.log("[PRODUCTION] API routes loaded");

    const clientDistPath = path.resolve(__dirname, "..", "client", "dist");

    console.log(`[PRODUCTION] Static files path: ${clientDistPath}`);
    console.log(`[PRODUCTION] Static files exist: ${fs.existsSync(clientDistPath)}`);

    if (fs.existsSync(clientDistPath)) {
      app.use(express.static(clientDistPath));
      app.use((_req, res, next) => {
        if (_req.path.startsWith("/api")) return next();
        res.sendFile(path.join(clientDistPath, "index.html"));
      });
    } else {
      console.error("[PRODUCTION] WARNING: client/dist not found - frontend will not work!");
    }

    isReady = true;

    console.log("========================================");
    console.log("🚀 Azul Vision AI Operations Hub");
    console.log("   Production Mode - Combined Server");
    console.log("========================================");
    console.log(`Server fully initialized on http://0.0.0.0:${PORT}`);
    console.log(`Domain: ${DOMAIN}`);
    console.log("========================================");
  } catch (err) {
    console.error("[PRODUCTION] App initialization error:", err);
    isReady = false;
  }
}
