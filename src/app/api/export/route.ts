import { z } from "zod";
import * as repo from "@/lib/db/repo";
import { db, handle, json } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Export complet des données personnelles (portabilité). */
export const GET = handle(async () => {
  const d = db();
  const body = JSON.stringify({
    exportedAt: new Date().toISOString(),
    facts: repo.listFacts(d), accounts: repo.listAccounts(d), holdings: repo.listHoldings(d), transactions: repo.listTransactions(d, 100_000),
    goals: repo.listGoals(d), decisions: repo.listDecisions(d), simulations: repo.listSimulations(d, 1000), netWorthHistory: repo.netWorthHistory(d), audit: repo.listAudit(d, 10_000),
  }, null, 2);
  return new Response(body, { headers: { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename="mes-donnees-financieres-${repo.today()}.json"`, "Cache-Control": "no-store" } });
});

/** Effacement complet, protégé par une confirmation explicite. */
export const DELETE = handle(async (request: Request) => {
  z.object({ confirmation: z.literal("EFFACER") }).parse(await request.json());
  repo.wipeAll(db());
  return json({ ok: true });
});
