import { createHash } from "node:crypto";
import { netWorth, type AccountKind, type AccountLike, type AssetClass, type HoldingLike } from "@/lib/engine";
import type { DB } from "./client";

export const today = (): string => new Date().toISOString().slice(0, 10);
const now = (): string => new Date().toISOString();

/* ───────────── Faits (mémoire structurée) ───────────── */

export type FactStatus = "verifie" | "estime" | "manquant";

export interface Fact {
  id: number;
  key: string;
  category: string;
  label: string;
  value: string | null;
  numericValue: number | null;
  status: FactStatus;
  source: string;
  asOf: string;
  updatedAt: string;
}

/** Clés connues du profil : l'IA et l'interface partagent ce vocabulaire. */
export const PROFILE_KEYS = {
  salary: { key: "revenu.salaire_net_mensuel", category: "revenu", label: "Salaire net mensuel" },
  rent: { key: "charge.loyer", category: "charge", label: "Loyer mensuel" },
  otherExpenses: { key: "charge.autres_depenses", category: "charge", label: "Autres dépenses mensuelles (hors loyer)" },
  riskTolerance: { key: "profil.tolerance_risque", category: "profil", label: "Tolérance au risque" },
  horizon: { key: "profil.horizon_annees", category: "profil", label: "Horizon d'investissement (années)" },
  taxParts: { key: "fiscal.parts", category: "fiscal", label: "Nombre de parts fiscales" },
  mainHome: { key: "projet.residence_principale", category: "projet", label: "Projet de résidence principale" },
  priority: { key: "objectif.priorite", category: "objectif", label: "Objectif prioritaire" },
} as const;

interface FactRow {
  id: number; key: string; category: string; label: string; value: string | null; numeric_value: number | null;
  status: FactStatus; source: string; as_of: string; updated_at: string;
}
const toFact = (r: FactRow): Fact => ({ id: r.id, key: r.key, category: r.category, label: r.label, value: r.value, numericValue: r.numeric_value, status: r.status, source: r.source, asOf: r.as_of, updatedAt: r.updated_at });

export function listFacts(db: DB): Fact[] {
  return (db.prepare("SELECT * FROM facts ORDER BY category, label").all() as FactRow[]).map(toFact);
}
export function getFact(db: DB, key: string): Fact | null {
  const row = db.prepare("SELECT * FROM facts WHERE key = ?").get(key) as FactRow | undefined;
  return row ? toFact(row) : null;
}
export function factNumber(db: DB, key: string): number | null {
  const f = getFact(db, key);
  return f && f.status !== "manquant" ? f.numericValue : null;
}

export interface FactInput {
  key: string;
  category: string;
  label: string;
  value: string | null;
  numericValue?: number | null;
  status: FactStatus;
  source: string;
  asOf?: string;
}

/** Enregistre un fait et conserve l'ancienne valeur dans l'historique (suivi dans le temps). */
export function upsertFact(db: DB, input: FactInput, actor: Actor = "utilisateur"): Fact {
  const asOf = input.asOf ?? today();
  const numeric = input.numericValue ?? null;
  db.transaction(() => {
    const existing = getFact(db, input.key);
    if (existing && (existing.value !== input.value || existing.numericValue !== numeric || existing.status !== input.status)) {
      db.prepare("INSERT INTO fact_history (fact_key, value, numeric_value, status, source, as_of, recorded_at) VALUES (?,?,?,?,?,?,?)")
        .run(existing.key, existing.value, existing.numericValue, existing.status, existing.source, existing.asOf, now());
    }
    db.prepare(
      `INSERT INTO facts (key, category, label, value, numeric_value, status, source, as_of, updated_at) VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(key) DO UPDATE SET category=excluded.category, label=excluded.label, value=excluded.value, numeric_value=excluded.numeric_value,
         status=excluded.status, source=excluded.source, as_of=excluded.as_of, updated_at=excluded.updated_at`,
    ).run(input.key, input.category, input.label, input.value, numeric, input.status, input.source, asOf, now());
    audit(db, actor, "memoire.maj", `${input.label} → ${input.value ?? "(manquant)"}`);
  })();
  return getFact(db, input.key)!;
}
export function deleteFact(db: DB, id: number): void {
  db.prepare("DELETE FROM facts WHERE id = ?").run(id);
}
export function factHistory(db: DB, key: string): { value: string | null; asOf: string; recordedAt: string }[] {
  return (db.prepare("SELECT value, as_of, recorded_at FROM fact_history WHERE fact_key = ? ORDER BY id DESC").all(key) as { value: string | null; as_of: string; recorded_at: string }[])
    .map((r) => ({ value: r.value, asOf: r.as_of, recordedAt: r.recorded_at }));
}

/* ───────────── Comptes ───────────── */

export interface Account extends AccountLike {
  source: string;
  notes: string | null;
}
interface AccountRow { id: number; name: string; institution: string | null; kind: AccountKind; balance: number; as_of: string; source: string; notes: string | null }
const toAccount = (r: AccountRow): Account => ({ id: r.id, name: r.name, institution: r.institution, kind: r.kind, balance: r.balance, asOf: r.as_of, source: r.source, notes: r.notes });

export function listAccounts(db: DB): Account[] {
  return (db.prepare("SELECT * FROM accounts WHERE archived = 0 ORDER BY id").all() as AccountRow[]).map(toAccount);
}

export interface AccountInput { name: string; institution?: string | null; kind: AccountKind; balance: number; asOf?: string; source?: string; notes?: string | null }

export function createAccount(db: DB, input: AccountInput, actor: Actor = "utilisateur"): Account {
  const asOf = input.asOf ?? today();
  const id = db.transaction(() => {
    const info = db.prepare("INSERT INTO accounts (name, institution, kind, balance, as_of, source, notes) VALUES (?,?,?,?,?,?,?)")
      .run(input.name, input.institution ?? null, input.kind, input.balance, asOf, input.source ?? "saisie manuelle", input.notes ?? null);
    const accountId = Number(info.lastInsertRowid);
    db.prepare("INSERT INTO account_snapshots (account_id, balance, as_of) VALUES (?,?,?)").run(accountId, input.balance, asOf);
    audit(db, actor, "compte.creation", `${input.name} : ${input.balance} €`);
    return accountId;
  })();
  recordNetWorthSnapshot(db);
  return listAccounts(db).find((a) => a.id === id)!;
}

export function updateAccount(db: DB, id: number, patch: Partial<AccountInput>, actor: Actor = "utilisateur"): Account | null {
  const current = listAccounts(db).find((a) => a.id === id);
  if (!current) return null;
  const next = { ...current, ...patch, asOf: patch.asOf ?? (patch.balance !== undefined ? today() : current.asOf) };
  db.transaction(() => {
    db.prepare("UPDATE accounts SET name=?, institution=?, kind=?, balance=?, as_of=?, source=?, notes=? WHERE id=?")
      .run(next.name, next.institution ?? null, next.kind, next.balance, next.asOf, next.source ?? current.source, next.notes ?? null, id);
    if (patch.balance !== undefined && patch.balance !== current.balance) {
      db.prepare("INSERT INTO account_snapshots (account_id, balance, as_of) VALUES (?,?,?)").run(id, next.balance, next.asOf);
      audit(db, actor, "compte.solde", `${next.name} : ${current.balance} € → ${next.balance} €`);
    }
  })();
  recordNetWorthSnapshot(db);
  return listAccounts(db).find((a) => a.id === id) ?? null;
}

export function archiveAccount(db: DB, id: number): void {
  db.prepare("UPDATE accounts SET archived = 1 WHERE id = ?").run(id);
  audit(db, "utilisateur", "compte.archive", `compte #${id}`);
  recordNetWorthSnapshot(db);
}

/** Une photographie du patrimoine par jour : base de la comparaison prévisions / réalité. */
export function recordNetWorthSnapshot(db: DB, date: string = today()): void {
  const accounts = listAccounts(db);
  if (accounts.length === 0) return;
  const nw = netWorth(accounts);
  db.prepare("INSERT INTO networth_snapshots (date, total, liquid, invested) VALUES (?,?,?,?) ON CONFLICT(date) DO UPDATE SET total=excluded.total, liquid=excluded.liquid, invested=excluded.invested")
    .run(date, nw.total, nw.liquid, nw.invested);
}
export function netWorthHistory(db: DB): { date: string; total: number; liquid: number; invested: number }[] {
  return db.prepare("SELECT * FROM networth_snapshots ORDER BY date").all() as { date: string; total: number; liquid: number; invested: number }[];
}

/* ───────────── Lignes de portefeuille ───────────── */

export interface Holding extends HoldingLike {
  quantity: number | null;
  source: string;
  isin: string | null;
  /** Prix de revient total (achats nets des ventes, frais inclus) : une donnée comptable, pas une valorisation. */
  costBasis: number | null;
}
interface HoldingRow { id: number; account_id: number | null; name: string; ticker: string | null; asset_class: AssetClass; sector: string | null; quantity: number | null; value: number | null; as_of: string | null; source: string; isin: string | null; cost_basis: number | null }
const toHolding = (r: HoldingRow): Holding => ({ id: r.id, accountId: r.account_id, name: r.name, ticker: r.ticker, assetClass: r.asset_class, sector: r.sector, quantity: r.quantity, value: r.value, asOf: r.as_of, source: r.source, isin: r.isin, costBasis: r.cost_basis });

export function listHoldings(db: DB): Holding[] {
  return (db.prepare("SELECT * FROM holdings ORDER BY value IS NULL, value DESC, name").all() as HoldingRow[]).map(toHolding);
}
export interface HoldingInput { accountId?: number | null; name: string; ticker?: string | null; assetClass?: AssetClass; sector?: string | null; quantity?: number | null; value?: number | null; asOf?: string | null; source?: string; isin?: string | null; costBasis?: number | null }

export function createHolding(db: DB, input: HoldingInput): Holding {
  const info = db.prepare("INSERT INTO holdings (account_id, name, ticker, asset_class, sector, quantity, value, as_of, source, isin, cost_basis) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(input.accountId ?? null, input.name, input.ticker ?? null, input.assetClass ?? "action", input.sector ?? null, input.quantity ?? null, input.value ?? null,
      input.value != null ? (input.asOf ?? today()) : null, input.source ?? "saisie manuelle", input.isin ?? null, input.costBasis ?? null);
  return listHoldings(db).find((h) => h.id === Number(info.lastInsertRowid))!;
}
export function updateHolding(db: DB, id: number, patch: HoldingInput): Holding | null {
  const current = listHoldings(db).find((h) => h.id === id);
  if (!current) return null;
  const next = { ...current, ...patch };
  const asOf = patch.value !== undefined ? (patch.value === null ? null : (patch.asOf ?? today())) : current.asOf;
  db.prepare("UPDATE holdings SET account_id=?, name=?, ticker=?, asset_class=?, sector=?, quantity=?, value=?, as_of=?, source=?, isin=?, cost_basis=? WHERE id=?")
    .run(next.accountId ?? null, next.name, next.ticker ?? null, next.assetClass, next.sector ?? null, next.quantity ?? null, next.value ?? null, asOf, next.source ?? current.source, next.isin ?? null, next.costBasis ?? null, id);
  return listHoldings(db).find((h) => h.id === id) ?? null;
}
export function deleteHolding(db: DB, id: number): void {
  db.prepare("DELETE FROM holdings WHERE id = ?").run(id);
}

/* ───────────── Opérations bancaires ───────────── */

export interface Transaction { id: number; accountId: number | null; date: string; label: string; amount: number; category: string; source: string }
interface TxRow { id: number; account_id: number | null; date: string; label: string; amount: number; category: string; source: string }
const toTx = (r: TxRow): Transaction => ({ id: r.id, accountId: r.account_id, date: r.date, label: r.label, amount: r.amount, category: r.category, source: r.source });

export function listTransactions(db: DB, limit = 500): Transaction[] {
  return (db.prepare("SELECT * FROM transactions ORDER BY date DESC, id DESC LIMIT ?").all(limit) as TxRow[]).map(toTx);
}
export interface TransactionInput { accountId?: number | null; date: string; label: string; amount: number; category?: string; source?: string; /** Identifiant stable fourni par la source (banque, courtier). */ externalId?: string }

/** Insère les opérations en ignorant les doublons (même date, libellé, montant, compte). */
export function insertTransactions(db: DB, inputs: TransactionInput[], categorize: (label: string, amount: number) => string, actor: Actor = "utilisateur"): { inserted: number; duplicates: number } {
  const stmt = db.prepare("INSERT OR IGNORE INTO transactions (account_id, date, label, amount, category, source, hash) VALUES (?,?,?,?,?,?,?)");
  let inserted = 0;
  db.transaction(() => {
    const seen = new Map<string, number>();
    for (const t of inputs) {
      const base = `${t.accountId ?? ""}|${t.date}|${t.label.trim().toLowerCase()}|${t.amount.toFixed(2)}`;
      const occurrence = seen.get(base) ?? 0;
      seen.set(base, occurrence + 1);
      const hash = createHash("sha256").update(t.externalId ? `ext|${t.accountId ?? ""}|${t.externalId}` : `${base}|${occurrence}`).digest("hex");
      const info = stmt.run(t.accountId ?? null, t.date, t.label.trim(), t.amount, t.category ?? categorize(t.label, t.amount), t.source ?? "saisie manuelle", hash);
      inserted += info.changes;
    }
  })();
  if (inserted > 0) audit(db, actor, "operations.import", `${inserted} opération(s) ajoutée(s)`);
  return { inserted, duplicates: inputs.length - inserted };
}
export function updateTransactionCategory(db: DB, id: number, category: string): void {
  db.prepare("UPDATE transactions SET category = ? WHERE id = ?").run(category, id);
}
export function deleteTransaction(db: DB, id: number): void {
  db.prepare("DELETE FROM transactions WHERE id = ?").run(id);
}

/* ───────────── Objectifs, prévisions, décisions, simulations ───────────── */

export interface Goal { id: number; title: string; targetAmount: number; targetDate: string | null; monthlyContribution: number | null; status: string; assumptions: Record<string, unknown>; createdAt: string }
interface GoalRow { id: number; title: string; target_amount: number; target_date: string | null; monthly_contribution: number | null; status: string; assumptions: string; created_at: string }
const toGoal = (r: GoalRow): Goal => ({ id: r.id, title: r.title, targetAmount: r.target_amount, targetDate: r.target_date, monthlyContribution: r.monthly_contribution, status: r.status, assumptions: JSON.parse(r.assumptions) as Record<string, unknown>, createdAt: r.created_at });

export function listGoals(db: DB): Goal[] {
  return (db.prepare("SELECT * FROM goals ORDER BY id DESC").all() as GoalRow[]).map(toGoal);
}
export interface GoalInput { title: string; targetAmount: number; targetDate?: string | null; monthlyContribution?: number | null; assumptions?: Record<string, unknown>; status?: string }
export function createGoal(db: DB, input: GoalInput, actor: Actor = "utilisateur"): Goal {
  const info = db.prepare("INSERT INTO goals (title, target_amount, target_date, monthly_contribution, assumptions, created_at) VALUES (?,?,?,?,?,?)")
    .run(input.title, input.targetAmount, input.targetDate ?? null, input.monthlyContribution ?? null, JSON.stringify(input.assumptions ?? {}), now());
  audit(db, actor, "objectif.creation", `${input.title} : ${input.targetAmount} €`);
  return listGoals(db).find((g) => g.id === Number(info.lastInsertRowid))!;
}
export function updateGoal(db: DB, id: number, patch: Partial<GoalInput>): Goal | null {
  const current = listGoals(db).find((g) => g.id === id);
  if (!current) return null;
  const next = { ...current, ...patch };
  db.prepare("UPDATE goals SET title=?, target_amount=?, target_date=?, monthly_contribution=?, status=?, assumptions=? WHERE id=?")
    .run(next.title, next.targetAmount, next.targetDate ?? null, next.monthlyContribution ?? null, next.status ?? current.status, JSON.stringify(next.assumptions ?? {}), id);
  return listGoals(db).find((g) => g.id === id) ?? null;
}
export function deleteGoal(db: DB, id: number): void {
  db.prepare("DELETE FROM goals WHERE id = ?").run(id);
}

export interface Forecast { goalId: number; createdAt: string; date: string; scenario: string; projected: number }
export function replaceForecasts(db: DB, goalId: number, points: { date: string; scenario: string; projected: number }[]): void {
  db.transaction(() => {
    db.prepare("DELETE FROM forecasts WHERE goal_id = ? AND date > ?").run(goalId, today());
    const stmt = db.prepare("INSERT INTO forecasts (goal_id, created_at, date, scenario, projected) VALUES (?,?,?,?,?)");
    for (const p of points) stmt.run(goalId, now(), p.date, p.scenario, p.projected);
  })();
}
export function listForecasts(db: DB, goalId: number): Forecast[] {
  return (db.prepare("SELECT goal_id, created_at, date, scenario, projected FROM forecasts WHERE goal_id = ? ORDER BY date").all(goalId) as { goal_id: number; created_at: string; date: string; scenario: string; projected: number }[])
    .map((r) => ({ goalId: r.goal_id, createdAt: r.created_at, date: r.date, scenario: r.scenario, projected: r.projected }));
}

export interface Decision { id: number; date: string; title: string; detail: string; assumptions: Record<string, unknown>; status: string }
export function listDecisions(db: DB): Decision[] {
  return (db.prepare("SELECT * FROM decisions ORDER BY id DESC").all() as { id: number; date: string; title: string; detail: string; assumptions: string; status: string }[])
    .map((r) => ({ ...r, assumptions: JSON.parse(r.assumptions) as Record<string, unknown> }));
}
export function createDecision(db: DB, input: { title: string; detail: string; assumptions?: Record<string, unknown> }, actor: Actor = "utilisateur"): Decision {
  const info = db.prepare("INSERT INTO decisions (date, title, detail, assumptions) VALUES (?,?,?,?)").run(today(), input.title, input.detail, JSON.stringify(input.assumptions ?? {}));
  audit(db, actor, "decision.creation", input.title);
  return listDecisions(db).find((d) => d.id === Number(info.lastInsertRowid))!;
}
export function setDecisionStatus(db: DB, id: number, status: string): void {
  db.prepare("UPDATE decisions SET status = ? WHERE id = ?").run(status, id);
}
export function deleteDecision(db: DB, id: number): void {
  db.prepare("DELETE FROM decisions WHERE id = ?").run(id);
}

export interface SimulationRecord { id: number; createdAt: string; kind: string; title: string; input: unknown; summary: unknown }
export function saveSimulation(db: DB, kind: string, title: string, input: unknown, summary: unknown): void {
  db.prepare("INSERT INTO simulations (created_at, kind, title, input, summary) VALUES (?,?,?,?,?)").run(now(), kind, title, JSON.stringify(input), JSON.stringify(summary));
}
export function listSimulations(db: DB, limit = 30): SimulationRecord[] {
  return (db.prepare("SELECT * FROM simulations ORDER BY id DESC LIMIT ?").all(limit) as { id: number; created_at: string; kind: string; title: string; input: string; summary: string }[])
    .map((r) => ({ id: r.id, createdAt: r.created_at, kind: r.kind, title: r.title, input: JSON.parse(r.input), summary: JSON.parse(r.summary) }));
}

/* ───────────── Conversation ───────────── */

export interface StoredMessage { id: number; role: "user" | "assistant"; content: string; blocks: unknown[]; steps: unknown[]; engine: string | null; createdAt: string }

export function currentConversationId(db: DB): number {
  const row = db.prepare("SELECT id FROM conversations ORDER BY id DESC LIMIT 1").get() as { id: number } | undefined;
  if (row) return row.id;
  return newConversation(db);
}
export function newConversation(db: DB): number {
  return Number(db.prepare("INSERT INTO conversations (title, created_at) VALUES (?,?)").run("Conversation", now()).lastInsertRowid);
}
export function listMessages(db: DB, conversationId: number): StoredMessage[] {
  return (db.prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY id").all(conversationId) as { id: number; role: "user" | "assistant"; content: string; blocks: string; steps: string; engine: string | null; created_at: string }[])
    .map((r) => ({ id: r.id, role: r.role, content: r.content, blocks: JSON.parse(r.blocks) as unknown[], steps: JSON.parse(r.steps) as unknown[], engine: r.engine, createdAt: r.created_at }));
}
export function addMessage(db: DB, conversationId: number, role: "user" | "assistant", content: string, blocks: unknown[] = [], steps: unknown[] = [], engine: string | null = null): number {
  return Number(db.prepare("INSERT INTO messages (conversation_id, role, content, blocks, steps, engine, created_at) VALUES (?,?,?,?,?,?,?)")
    .run(conversationId, role, content, JSON.stringify(blocks), JSON.stringify(steps), engine, now()).lastInsertRowid);
}

/* ───────────── Alertes ───────────── */

export interface AlertRecord { id: number; key: string; severity: string; agent: string; title: string; detail: string; prompt: string | null; createdAt: string }

/** Remplace l'ensemble des alertes actives ; une alerte ignorée ne réapparaît que si sa cause a changé. */
export function syncAlerts(db: DB, alerts: { key: string; severity: string; agent: string; title: string; detail: string; prompt?: string; fingerprint: string }[]): void {
  db.transaction(() => {
    const keys = alerts.map((a) => a.key);
    const existing = db.prepare("SELECT key FROM alerts").all() as { key: string }[];
    for (const e of existing) if (!keys.includes(e.key)) db.prepare("DELETE FROM alerts WHERE key = ?").run(e.key);
    const stmt = db.prepare(
      `INSERT INTO alerts (key, severity, agent, title, detail, prompt, fingerprint, created_at) VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(key) DO UPDATE SET severity=excluded.severity, agent=excluded.agent, title=excluded.title, detail=excluded.detail, prompt=excluded.prompt, fingerprint=excluded.fingerprint`,
    );
    for (const a of alerts) stmt.run(a.key, a.severity, a.agent, a.title, a.detail, a.prompt ?? null, a.fingerprint, now());
  })();
}
export function listActiveAlerts(db: DB): AlertRecord[] {
  return (db.prepare("SELECT * FROM alerts WHERE dismissed_fingerprint IS NULL OR dismissed_fingerprint != fingerprint ORDER BY CASE severity WHEN 'critique' THEN 0 WHEN 'important' THEN 1 ELSE 2 END, id").all() as { id: number; key: string; severity: string; agent: string; title: string; detail: string; prompt: string | null; created_at: string }[])
    .map((r) => ({ id: r.id, key: r.key, severity: r.severity, agent: r.agent, title: r.title, detail: r.detail, prompt: r.prompt, createdAt: r.created_at }));
}
export function dismissAlert(db: DB, id: number): void {
  db.prepare("UPDATE alerts SET dismissed_fingerprint = fingerprint WHERE id = ?").run(id);
}

/* ───────────── Opérations préparées (jamais exécutées sans confirmation) ───────────── */

export interface PendingAction { id: number; createdAt: string; kind: string; title: string; params: Record<string, unknown>; status: "preparee" | "confirmee" | "annulee"; resolvedAt: string | null }
const toAction = (r: { id: number; created_at: string; kind: string; title: string; params: string; status: PendingAction["status"]; resolved_at: string | null }): PendingAction =>
  ({ id: r.id, createdAt: r.created_at, kind: r.kind, title: r.title, params: JSON.parse(r.params) as Record<string, unknown>, status: r.status, resolvedAt: r.resolved_at });

export function createPendingAction(db: DB, kind: string, title: string, params: Record<string, unknown>): PendingAction {
  const info = db.prepare("INSERT INTO pending_actions (created_at, kind, title, params) VALUES (?,?,?,?)").run(now(), kind, title, JSON.stringify(params));
  audit(db, "ia", "operation.preparation", title);
  return getPendingAction(db, Number(info.lastInsertRowid))!;
}
export function getPendingAction(db: DB, id: number): PendingAction | null {
  const row = db.prepare("SELECT * FROM pending_actions WHERE id = ?").get(id) as Parameters<typeof toAction>[0] | undefined;
  return row ? toAction(row) : null;
}
export function listPendingActions(db: DB): PendingAction[] {
  return (db.prepare("SELECT * FROM pending_actions ORDER BY id DESC LIMIT 50").all() as Parameters<typeof toAction>[0][]).map(toAction);
}
export function resolvePendingAction(db: DB, id: number, status: "confirmee" | "annulee"): PendingAction | null {
  const action = getPendingAction(db, id);
  if (!action || action.status !== "preparee") return action;
  db.prepare("UPDATE pending_actions SET status = ?, resolved_at = ? WHERE id = ?").run(status, now(), id);
  audit(db, "utilisateur", status === "confirmee" ? "operation.confirmation" : "operation.annulation", action.title);
  return getPendingAction(db, id);
}

/* ───────────── Connexions bancaires ───────────── */

export type ConnectionStatus = "en_attente" | "active" | "expiree" | "erreur";
export interface BankConnection { id: number; provider: string; aspspName: string; aspspCountry: string; state: string; sessionId: string | null; status: ConnectionStatus; validUntil: string | null; createdAt: string; lastSyncAt: string | null; lastError: string | null }
interface ConnRow { id: number; provider: string; aspsp_name: string; aspsp_country: string; state: string; session_id: string | null; status: ConnectionStatus; valid_until: string | null; created_at: string; last_sync_at: string | null; last_error: string | null }
const toConn = (r: ConnRow): BankConnection => ({ id: r.id, provider: r.provider, aspspName: r.aspsp_name, aspspCountry: r.aspsp_country, state: r.state, sessionId: r.session_id, status: r.status, validUntil: r.valid_until, createdAt: r.created_at, lastSyncAt: r.last_sync_at, lastError: r.last_error });

export interface BankAccountLink { id: number; connectionId: number; externalUid: string; identificationHash: string; label: string; ibanMasked: string | null; accountType: string; currency: string; accountId: number | null }
interface LinkRow { id: number; connection_id: number; external_uid: string; identification_hash: string; label: string; iban_masked: string | null; account_type: string; currency: string; account_id: number | null }
const toLink = (r: LinkRow): BankAccountLink => ({ id: r.id, connectionId: r.connection_id, externalUid: r.external_uid, identificationHash: r.identification_hash, label: r.label, ibanMasked: r.iban_masked, accountType: r.account_type, currency: r.currency, accountId: r.account_id });

export function createPendingConnection(db: DB, input: { provider: string; aspspName: string; aspspCountry: string; state: string; validUntil: string }): BankConnection {
  // Une seule demande en attente par banque : les tentatives abandonnées ne s'accumulent pas.
  db.prepare("DELETE FROM bank_connections WHERE status = 'en_attente' AND aspsp_name = ? AND aspsp_country = ?").run(input.aspspName, input.aspspCountry);
  const info = db.prepare("INSERT INTO bank_connections (provider, aspsp_name, aspsp_country, state, status, valid_until, created_at) VALUES (?,?,?,?,'en_attente',?,?)")
    .run(input.provider, input.aspspName, input.aspspCountry, input.state, input.validUntil, now());
  return getConnection(db, Number(info.lastInsertRowid))!;
}
export function getConnection(db: DB, id: number): BankConnection | null {
  const row = db.prepare("SELECT * FROM bank_connections WHERE id = ?").get(id) as ConnRow | undefined;
  return row ? toConn(row) : null;
}
export function findPendingConnectionByState(db: DB, state: string): BankConnection | null {
  const row = db.prepare("SELECT * FROM bank_connections WHERE state = ? AND status = 'en_attente'").get(state) as ConnRow | undefined;
  return row ? toConn(row) : null;
}
export function listConnections(db: DB): BankConnection[] {
  return (db.prepare("SELECT * FROM bank_connections WHERE status != 'en_attente' ORDER BY id").all() as ConnRow[]).map(toConn);
}
export function activateConnection(db: DB, id: number, sessionId: string, validUntil: string | null): void {
  db.prepare("UPDATE bank_connections SET session_id = ?, status = 'active', valid_until = COALESCE(?, valid_until), last_error = NULL WHERE id = ?").run(sessionId, validUntil, id);
  const c = getConnection(db, id)!;
  audit(db, "utilisateur", "banque.connexion", `${c.aspspName} : accès en lecture autorisé`);
}
export function setConnectionState(db: DB, id: number, patch: { status?: ConnectionStatus; lastSyncAt?: string; lastError?: string | null }): void {
  const c = getConnection(db, id);
  if (!c) return;
  db.prepare("UPDATE bank_connections SET status = ?, last_sync_at = ?, last_error = ? WHERE id = ?")
    .run(patch.status ?? c.status, patch.lastSyncAt ?? c.lastSyncAt, patch.lastError === undefined ? c.lastError : patch.lastError, id);
}
export function deleteConnection(db: DB, id: number): void {
  const c = getConnection(db, id);
  db.prepare("DELETE FROM bank_connections WHERE id = ?").run(id);
  if (c) audit(db, "utilisateur", "banque.deconnexion", c.aspspName);
}
export function replaceBankAccounts(db: DB, connectionId: number, accounts: Omit<BankAccountLink, "id" | "connectionId" | "accountId">[]): void {
  db.transaction(() => {
    // Les rattachements existants sont conservés d'une autorisation à l'autre grâce à l'empreinte du compte.
    const previous = new Map(listBankAccounts(db).map((a) => [a.identificationHash, a.accountId]));
    db.prepare("DELETE FROM bank_accounts WHERE connection_id = ?").run(connectionId);
    const stmt = db.prepare("INSERT INTO bank_accounts (connection_id, external_uid, identification_hash, label, iban_masked, account_type, currency, account_id) VALUES (?,?,?,?,?,?,?,?)");
    for (const a of accounts) stmt.run(connectionId, a.externalUid, a.identificationHash, a.label, a.ibanMasked, a.accountType, a.currency, previous.get(a.identificationHash) ?? null);
  })();
}
export function listBankAccounts(db: DB, connectionId?: number): BankAccountLink[] {
  const rows = connectionId === undefined ? db.prepare("SELECT * FROM bank_accounts ORDER BY id").all() : db.prepare("SELECT * FROM bank_accounts WHERE connection_id = ? ORDER BY id").all(connectionId);
  return (rows as LinkRow[]).map(toLink);
}
export function linkBankAccount(db: DB, id: number, accountId: number | null): void {
  db.prepare("UPDATE bank_accounts SET account_id = ? WHERE id = ?").run(accountId, id);
}

/* ───────────── Journal d'audit ───────────── */

export type Actor = "utilisateur" | "ia" | "systeme";
export function audit(db: DB, actor: Actor, action: string, detail: string): void {
  db.prepare("INSERT INTO audit_log (at, actor, action, detail) VALUES (?,?,?,?)").run(now(), actor, action, detail);
}
export function listAudit(db: DB, limit = 100): { at: string; actor: string; action: string; detail: string }[] {
  return db.prepare("SELECT at, actor, action, detail FROM audit_log ORDER BY id DESC LIMIT ?").all(limit) as { at: string; actor: string; action: string; detail: string }[];
}

export function isEmpty(db: DB): boolean {
  const a = db.prepare("SELECT COUNT(*) AS n FROM accounts").get() as { n: number };
  const f = db.prepare("SELECT COUNT(*) AS n FROM facts").get() as { n: number };
  return a.n === 0 && f.n === 0;
}

/** Efface toutes les données personnelles (droit à l'effacement). */
export function wipeAll(db: DB): void {
  db.transaction(() => {
    for (const t of ["bank_accounts", "bank_connections", "forecasts", "goals", "decisions", "simulations", "messages", "conversations", "alerts", "pending_actions", "transactions", "holdings", "account_snapshots", "networth_snapshots", "accounts", "fact_history", "facts", "audit_log"]) {
      db.exec(`DELETE FROM ${t}`);
    }
  })();
}
