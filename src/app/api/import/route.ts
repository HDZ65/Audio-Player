import { z } from "zod";
import { categorize } from "@/lib/budget/categorize";
import { parseBankCsv } from "@/lib/budget/csv";
import { applyTradeRepublicImport, parseTradeRepublicCsv } from "@/lib/connectors/traderepublic";
import { insertTransactions, isEmpty, listAccounts } from "@/lib/db/repo";
import { importSituation } from "@/lib/db/seed";
import { refreshAlerts } from "@/lib/monitor/alerts";
import { db, handle, json } from "@/lib/server";

const schema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("csv"), text: z.string().max(5_000_000), accountId: z.number().int().nullable().optional() }),
  z.object({ type: z.literal("situation"), situation: z.unknown() }),
  z.object({ type: z.literal("trade_republic"), text: z.string().max(10_000_000), accountId: z.number().int().positive(), preview: z.boolean().optional() }),
]);

export const POST = handle(async (request: Request) => {
  const body = schema.parse(await request.json());
  const database = db();
  if (body.type === "csv") {
    const parsed = parseBankCsv(body.text, body.accountId ?? null);
    if (parsed.error) return json({ error: parsed.error }, 400);
    const result = insertTransactions(database, parsed.transactions, categorize);
    refreshAlerts(database);
    return json({ ...result, skipped: parsed.skipped });
  }
  if (body.type === "trade_republic") {
    if (!listAccounts(database).some((a) => a.id === body.accountId)) return json({ error: "Compte inconnu" }, 404);
    const parsed = parseTradeRepublicCsv(body.text, body.accountId);
    if (parsed.error) return json({ error: parsed.error }, 400);
    // Aperçu d'abord : l'utilisateur voit ce qui sera écrit avant de valider.
    if (body.preview) return json({ preview: true, positions: parsed.positions, stats: parsed.stats, warnings: parsed.warnings });
    const applied = applyTradeRepublicImport(database, body.accountId, parsed);
    refreshAlerts(database);
    return json({ preview: false, ...applied, stats: parsed.stats, warnings: parsed.warnings });
  }
  if (!isEmpty(database)) return json({ error: "Des données existent déjà. Efface-les d'abord depuis Mémoire pour importer une nouvelle situation de départ." }, 409);
  const result = importSituation(database, body.situation);
  refreshAlerts(database);
  return json(result, 201);
});
