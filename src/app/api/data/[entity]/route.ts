import { z } from "zod";
import { buildContext } from "@/lib/ai/context";
import { CATEGORIES, categorize } from "@/lib/budget/categorize";
import type { DB } from "@/lib/db/client";
import * as repo from "@/lib/db/repo";
import { refreshAlerts } from "@/lib/monitor/alerts";
import { db, handle, json } from "@/lib/server";

export const dynamic = "force-dynamic";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const money = z.number().finite().min(-100_000_000).max(100_000_000);
const kind = z.enum(["courant", "livret", "pea", "cto", "assurance_vie", "credit", "immobilier", "autre"]);
const assetClass = z.enum(["action", "etf", "obligation", "fonds", "crypto", "autre"]);
const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional().transform((v) => (v === "" ? null : v));

const accountSchema = z.object({ name: text(120), institution: optionalText(120), kind, balance: money, asOf: date.optional(), notes: optionalText(500) });
const holdingSchema = z.object({ accountId: z.number().int().nullable().optional(), name: text(120), ticker: optionalText(20), assetClass: assetClass.optional(), sector: optionalText(80), quantity: z.number().finite().nonnegative().nullable().optional(), value: z.number().finite().nonnegative().nullable().optional() });
const transactionSchema = z.object({ accountId: z.number().int().nullable().optional(), date, label: text(200), amount: money, category: z.enum(CATEGORIES).optional() });
const goalSchema = z.object({ title: text(140), targetAmount: z.number().finite().positive().max(1_000_000_000), targetDate: date.nullable().optional(), monthlyContribution: z.number().finite().nonnegative().nullable().optional(), status: z.enum(["actif", "atteint", "abandonne"]).optional() });
const decisionSchema = z.object({ title: text(140), detail: text(1000) });
const factSchema = z.object({ key: z.string().regex(/^[a-z_]+\.[a-z0-9_]+$/).max(80), category: text(40), label: text(120), value: z.string().trim().max(500).nullable(), numericValue: z.number().finite().nullable().optional(), status: z.enum(["verifie", "estime", "manquant"]) });

interface Entity {
  list: (d: DB) => unknown;
  create?: (d: DB, body: unknown) => unknown;
  update?: (d: DB, id: number, body: unknown) => unknown;
  remove?: (d: DB, id: number) => void;
}

const ENTITIES: Record<string, Entity> = {
  accounts: {
    list: (d) => repo.listAccounts(d),
    create: (d, b) => repo.createAccount(d, accountSchema.parse(b)),
    update: (d, id, b) => repo.updateAccount(d, id, accountSchema.partial().parse(b)),
    remove: (d, id) => repo.archiveAccount(d, id),
  },
  holdings: {
    list: (d) => repo.listHoldings(d),
    create: (d, b) => repo.createHolding(d, holdingSchema.parse(b)),
    update: (d, id, b) => repo.updateHolding(d, id, holdingSchema.partial().parse(b) as repo.HoldingInput),
    remove: (d, id) => repo.deleteHolding(d, id),
  },
  transactions: {
    list: (d) => ({ transactions: repo.listTransactions(d), categories: CATEGORIES, observed: buildContext(d).observedSpending }),
    create: (d, b) => repo.insertTransactions(d, [transactionSchema.parse(b)], categorize),
    update: (d, id, b) => repo.updateTransactionCategory(d, id, z.object({ category: z.enum(CATEGORIES) }).parse(b).category),
    remove: (d, id) => repo.deleteTransaction(d, id),
  },
  goals: {
    list: (d) => {
      const ctx = buildContext(d);
      return { goals: ctx.goals.map((g) => ({ ...g, forecasts: repo.listForecasts(d, g.id).filter((f) => f.scenario === "central") })), decisions: ctx.decisions, simulations: repo.listSimulations(d), checks: ctx.forecastChecks, history: ctx.history };
    },
    create: (d, b) => repo.createGoal(d, goalSchema.parse(b)),
    update: (d, id, b) => repo.updateGoal(d, id, goalSchema.partial().parse(b)),
    remove: (d, id) => repo.deleteGoal(d, id),
  },
  decisions: {
    list: (d) => repo.listDecisions(d),
    create: (d, b) => {
      const ctx = buildContext(d);
      return repo.createDecision(d, { ...decisionSchema.parse(b), assumptions: { salaireNetMensuel: ctx.salary, depensesMensuelles: ctx.budget.totalExpenses, patrimoineNet: ctx.netWorth.total, date: ctx.date } });
    },
    update: (d, id, b) => repo.setDecisionStatus(d, id, z.object({ status: z.enum(["active", "revue", "abandonnee"]) }).parse(b).status),
    remove: (d, id) => repo.deleteDecision(d, id),
  },
  facts: {
    list: (d) => ({ facts: repo.listFacts(d).map((f) => ({ ...f, history: repo.factHistory(d, f.key) })), audit: repo.listAudit(d, 60) }),
    create: (d, b) => repo.upsertFact(d, { ...factSchema.parse(b), source: "saisie manuelle" }),
    remove: (d, id) => repo.deleteFact(d, id),
  },
  alerts: {
    list: (d) => refreshAlerts(d).alerts,
    remove: (d, id) => repo.dismissAlert(d, id),
  },
  actions: {
    list: (d) => repo.listPendingActions(d),
    // Confirmer consigne l'accord de l'utilisateur ; l'application n'exécute aucune opération externe.
    update: (d, id, b) => repo.resolvePendingAction(d, id, z.object({ status: z.enum(["confirmee", "annulee"]) }).parse(b).status),
  },
};

type Ctx = { params: Promise<{ entity: string }> };

const resolve = async (context: Ctx): Promise<Entity | null> => ENTITIES[(await context.params).entity] ?? null;
const idOf = (request: Request): number | null => {
  const id = Number(new URL(request.url).searchParams.get("id"));
  return Number.isInteger(id) && id > 0 ? id : null;
};

export const GET = handle(async (_request: Request, context: Ctx) => {
  const entity = await resolve(context);
  return entity ? json(entity.list(db())) : json({ error: "Ressource inconnue" }, 404);
});

export const POST = handle(async (request: Request, context: Ctx) => {
  const entity = await resolve(context);
  if (!entity?.create) return json({ error: "Opération non disponible" }, 405);
  const database = db();
  const created = entity.create(database, await request.json());
  refreshAlerts(database);
  return json(created, 201);
});

export const PATCH = handle(async (request: Request, context: Ctx) => {
  const entity = await resolve(context);
  const id = idOf(request);
  if (!entity?.update || id === null) return json({ error: "Opération non disponible" }, 405);
  const database = db();
  const updated = entity.update(database, id, await request.json());
  refreshAlerts(database);
  return json(updated ?? { ok: true });
});

export const DELETE = handle(async (request: Request, context: Ctx) => {
  const entity = await resolve(context);
  const id = idOf(request);
  if (!entity?.remove || id === null) return json({ error: "Opération non disponible" }, 405);
  const database = db();
  entity.remove(database, id);
  refreshAlerts(database);
  return json({ ok: true });
});
