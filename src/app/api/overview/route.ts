import { buildContext } from "@/lib/ai/context";
import { isModelConfigured, modelName } from "@/lib/ai/orchestrator";
import { currentConversationId, listMessages, listPendingActions } from "@/lib/db/repo";
import { refreshAlerts } from "@/lib/monitor/alerts";
import { authEnabled } from "@/lib/security/auth";
import { db, handle, json } from "@/lib/server";

export const dynamic = "force-dynamic";

export const GET = handle(async () => {
  const database = db();
  const ctx = buildContext(database);
  const { findings, alerts } = refreshAlerts(database, ctx);
  const activeKeys = new Set(alerts.map((a) => a.key));
  // L'accueil montre peu de choses : les alertes actives d'abord, complétées par des pistes utiles.
  const insights = [
    ...findings.filter((f) => f.severity !== "info" && activeKeys.has(f.key)),
    ...findings.filter((f) => f.severity === "info"),
  ].slice(0, 4).map((f) => ({ key: f.key, agent: f.agent, severity: f.severity, nature: f.nature, title: f.title, detail: f.detail, prompt: f.prompt ?? null, alertId: alerts.find((a) => a.key === f.key)?.id ?? null }));

  const actions = listPendingActions(database);
  const messages = listMessages(database, currentConversationId(database)).map((m) => ({
    ...m,
    blocks: (m.blocks as { type: string; actionId?: number; status?: string }[]).map((b) => (b.type === "action" ? { ...b, status: actions.find((a) => a.id === b.actionId)?.status ?? b.status } : b)),
  }));

  return json({
    isEmpty: ctx.isEmpty,
    date: ctx.date,
    asOf: ctx.netWorth.oldestAsOf,
    netWorth: ctx.netWorth,
    budget: ctx.budget,
    emergency: ctx.emergency,
    history: ctx.history,
    missing: ctx.missing,
    stale: ctx.stale,
    tax: ctx.tax,
    insights,
    alertCount: alerts.length,
    messages,
    engine: isModelConfigured() ? { kind: "modele", name: modelName(), webSearch: process.env.ENABLE_WEB_SEARCH === "true" } : { kind: "local", name: "Mode local", webSearch: false },
    authEnabled: authEnabled(),
  });
});
