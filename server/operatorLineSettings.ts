import type { Express, RequestHandler } from "express";
import type { PluginStore } from "../src/plugin/store";

/** Mount with the same session auth and admin role middleware as app settings. */
export function mountOperatorLineSettings(app: Express, deps: {
  authenticate: RequestHandler;
  admin: RequestHandler;
  store: () => PluginStore | null;
  env: Record<string, string | undefined>;
}) {
  const view = async () => {
    const store = deps.store();
    if (!store) throw new Error("operator settings unavailable");
    const enabled = await store.getOperatorLineEnabled();
    const environmentEnabled = deps.env.OPERATOR_LINE_INBOUND_ENABLED === "true";
    return { enabled, environmentEnabled, effectiveEnabled: enabled && environmentEnabled };
  };
  app.get("/api/settings/operator-line", deps.authenticate, async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try { res.json(await view()); }
    catch { res.status(503).json({ error: "Operator settings unavailable" }); }
  });
  app.put("/api/settings/operator-line", deps.authenticate, deps.admin, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (typeof req.body?.enabled !== "boolean") { res.status(400).json({ error: "enabled must be a boolean" }); return; }
    try {
      const store = deps.store();
      if (!store) throw new Error("operator settings unavailable");
      await store.setOperatorLineEnabled(req.body.enabled, req.session?.userId ?? (req.user as any)?.claims?.sub ?? null);
      res.json(await view());
    } catch { res.status(503).json({ error: "Operator settings unavailable" }); }
  });
}
