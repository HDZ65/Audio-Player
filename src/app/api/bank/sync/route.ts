import { z } from "zod";
import { configFromEnv } from "@/lib/connectors/enablebanking";
import { syncConnection } from "@/lib/connectors/sync";
import { listConnections } from "@/lib/db/repo";
import { db, handle, json } from "@/lib/server";

export const maxDuration = 120;

/** Les banques limitent les lectures sans présence du client : pas plus d'une synchronisation automatique toutes les 12 heures. */
const AUTO_INTERVAL_MS = 12 * 3_600_000;

export const POST = handle(async (request: Request) => {
  const config = configFromEnv();
  if (!config) return json({ reports: [], skipped: "non configuré" });
  const { auto } = z.object({ auto: z.boolean().optional() }).parse(await request.json().catch(() => ({})));
  const database = db();
  const reports = [];
  for (const c of listConnections(database)) {
    if (c.status === "expiree") continue;
    if (auto && c.lastSyncAt && Date.now() - Date.parse(c.lastSyncAt) < AUTO_INTERVAL_MS) continue;
    reports.push(await syncConnection(database, config, c.id));
  }
  return json({ reports });
});
