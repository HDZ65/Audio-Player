import { buildContext, type FinancialContext } from "@/lib/ai/context";
import { runSpecialists, type Finding } from "@/lib/ai/specialists";
import type { DB } from "@/lib/db/client";
import { listActiveAlerts, syncAlerts, type AlertRecord } from "@/lib/db/repo";

/**
 * Surveillance : rejoue les spécialistes sur la situation courante et ne garde comme alertes
 * que les constats critiques ou importants. Les simples fluctuations de cours n'en créent jamais :
 * seules les causes structurelles (seuil franchi, donnée manquante, hypothèse caduque) comptent.
 */
export function refreshAlerts(db: DB, ctx: FinancialContext = buildContext(db)): { findings: Finding[]; alerts: AlertRecord[] } {
  const findings = runSpecialists(ctx);
  syncAlerts(db, findings.filter((f) => f.severity !== "info").map((f) => ({ key: f.key, severity: f.severity, agent: f.agent, title: f.title, detail: f.detail, prompt: f.prompt, fingerprint: f.fingerprint })));
  return { findings, alerts: listActiveAlerts(db) };
}
