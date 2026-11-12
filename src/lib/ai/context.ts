import {
  analyzePortfolio, budgetSummary, emergencyFund, estimateIncomeTax, netWorth, round2,
  type BudgetSummary, type EmergencyFund, type NetWorth, type PortfolioAnalysis,
} from "@/lib/engine";
import { NON_SPENDING } from "@/lib/budget/categorize";
import type { DB } from "@/lib/db/client";
import {
  PROFILE_KEYS, factNumber, getFact, listAccounts, listDecisions, listFacts, listForecasts, listGoals, listHoldings, listTransactions,
  netWorthHistory, today, type Account, type Decision, type Fact, type Goal, type Holding, type Transaction,
} from "@/lib/db/repo";

const STALE_DAYS = 45;
const daysBetween = (a: string, b: string): number => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

export interface ObservedSpending {
  months: number;
  averageMonthly: number;
  /** Moyenne hors logement : comparable à « autres dépenses ». */
  averageMonthlyExcludingHousing: number;
  byCategory: { category: string; averageMonthly: number }[];
  from: string;
  to: string;
}

export interface FinancialContext {
  date: string;
  facts: Fact[];
  accounts: Account[];
  holdings: Holding[];
  transactions: Transaction[];
  goals: (Goal & { progress: number; current: number })[];
  decisions: Decision[];
  netWorth: NetWorth;
  budget: BudgetSummary;
  emergency: EmergencyFund | null;
  portfolio: PortfolioAnalysis;
  tax: { taxable: number; tax: number; marginalRate: number; parts: number } | null;
  observedSpending: ObservedSpending | null;
  history: { date: string; total: number }[];
  /** Écarts entre les prévisions passées et le patrimoine réellement observé. */
  forecastChecks: { goal: string; date: string; projected: number; actual: number; gap: number }[];
  missing: string[];
  stale: string[];
  salary: number | null;
  rent: number | null;
  otherExpenses: number | null;
  isEmpty: boolean;
}

/** Dépenses moyennes observées sur les mois complets disponibles (3 au plus). */
export function observeSpending(transactions: Transaction[], date: string): ObservedSpending | null {
  const currentMonth = date.slice(0, 7);
  const months = [...new Set(transactions.map((t) => t.date.slice(0, 7)))].filter((m) => m < currentMonth).sort().slice(-3);
  if (months.length === 0) return null;
  const spending = transactions.filter((t) => months.includes(t.date.slice(0, 7)) && t.amount < 0 && !NON_SPENDING.includes(t.category));
  if (spending.length === 0) return null;
  const byCategory = new Map<string, number>();
  for (const t of spending) byCategory.set(t.category, (byCategory.get(t.category) ?? 0) - t.amount);
  const total = [...byCategory.values()].reduce((a, b) => a + b, 0);
  return {
    months: months.length,
    averageMonthly: round2(total / months.length),
    averageMonthlyExcludingHousing: round2((total - (byCategory.get("logement") ?? 0)) / months.length),
    byCategory: [...byCategory.entries()].map(([category, v]) => ({ category, averageMonthly: round2(v / months.length) })).sort((a, b) => b.averageMonthly - a.averageMonthly),
    from: months[0]!,
    to: months[months.length - 1]!,
  };
}

/** Photographie complète et datée de la situation : unique source de vérité des agents et de l'interface. */
export function buildContext(db: DB): FinancialContext {
  const date = today();
  const facts = listFacts(db);
  const accounts = listAccounts(db);
  const holdings = listHoldings(db);
  const transactions = listTransactions(db, 2000);
  const salary = factNumber(db, PROFILE_KEYS.salary.key);
  const rent = factNumber(db, PROFILE_KEYS.rent.key);
  const otherExpenses = factNumber(db, PROFILE_KEYS.otherExpenses.key);
  const parts = factNumber(db, PROFILE_KEYS.taxParts.key) ?? 1;

  const nw = netWorth(accounts);
  const budget = budgetSummary({ netMonthlyIncome: salary, rent, otherExpenses });
  const emergency = emergencyFund(nw.liquid, budget);
  const portfolio = analyzePortfolio(accounts, holdings);
  const history = netWorthHistory(db).map((h) => ({ date: h.date, total: h.total }));

  const missing = [...budget.missing];
  if (accounts.length === 0) missing.push("comptes et soldes");
  if (!getFact(db, PROFILE_KEYS.riskTolerance.key)) missing.push("tolérance au risque");
  if (!getFact(db, PROFILE_KEYS.horizon.key)) missing.push("horizon d'investissement");
  if (portfolio.investedTotal > 0 && portfolio.coverage < 0.8) missing.push("détail valorisé des lignes de portefeuille");
  if (accounts.some((a) => a.kind === "pea") && !getFact(db, "fiscal.pea_date_ouverture")) missing.push("date d'ouverture du PEA");

  const stale: string[] = [];
  for (const a of accounts) {
    const age = daysBetween(a.asOf, date);
    if (age > STALE_DAYS) stale.push(`${a.name} (solde du ${a.asOf}, il y a ${age} jours)`);
  }
  for (const f of facts) {
    if (f.status !== "manquant" && ["revenu", "charge"].includes(f.category) && daysBetween(f.asOf, date) > 365) stale.push(`${f.label} (du ${f.asOf})`);
  }

  const goals = listGoals(db).map((g) => ({ ...g, current: nw.total, progress: g.targetAmount > 0 ? round2(Math.min(1, nw.total / g.targetAmount) * 1000) / 1000 : 0 }));

  const forecastChecks: FinancialContext["forecastChecks"] = [];
  for (const g of goals) {
    const due = listForecasts(db, g.id).filter((f) => f.scenario === "central" && f.date <= date);
    const last = due[due.length - 1];
    if (!last) continue;
    const snapshot = [...history].reverse().find((h) => h.date <= last.date) ?? history[0];
    if (snapshot) forecastChecks.push({ goal: g.title, date: last.date, projected: last.projected, actual: snapshot.total, gap: round2(snapshot.total - last.projected) });
  }

  return {
    date, facts, accounts, holdings, transactions, goals, decisions: listDecisions(db), netWorth: nw, budget, emergency, portfolio,
    tax: salary !== null ? { ...estimateIncomeTax(salary * 12, parts), parts } : null,
    observedSpending: observeSpending(transactions, date),
    history, forecastChecks, missing, stale, salary, rent, otherExpenses,
    isEmpty: accounts.length === 0 && facts.length === 0,
  };
}

const STATUS_LABEL: Record<string, string> = { verifie: "vérifié", estime: "estimation", manquant: "MANQUANT" };

/** Version texte du contexte, injectée dans le prompt du modèle. Ne contient ni identifiant bancaire ni nom. */
export function contextForModel(ctx: FinancialContext): string {
  const lines: string[] = [];
  lines.push(`Date du jour : ${ctx.date}`);
  lines.push("", "## Mémoire (faits déclarés)");
  for (const f of ctx.facts) lines.push(`- [${STATUS_LABEL[f.status]}] ${f.label} : ${f.value ?? "non renseigné"} (source : ${f.source}, au ${f.asOf})`);
  lines.push("", "## Comptes (photographies datées, pas du temps réel)");
  for (const a of ctx.accounts) lines.push(`- ${a.name} [${a.kind}] : ${a.balance.toFixed(2)} € au ${a.asOf}`);
  lines.push("", `## Patrimoine net calculé : ${ctx.netWorth.total.toFixed(2)} € (liquidités ${ctx.netWorth.liquid.toFixed(2)} €, placements ${ctx.netWorth.invested.toFixed(2)} €, dettes ${ctx.netWorth.debts.toFixed(2)} €)`);
  lines.push("", "## Lignes de portefeuille identifiées");
  for (const h of ctx.holdings) lines.push(`- ${h.name} (${h.assetClass}${h.sector ? `, ${h.sector}` : ""}) : ${h.value !== null ? `${h.value.toFixed(2)} € au ${h.asOf}` : "valeur inconnue"}`);
  if (ctx.holdings.length === 0) lines.push("- aucune");
  lines.push("", "## Budget");
  lines.push(`- Capacité d'épargne mensuelle : ${ctx.budget.savingsCapacity !== null ? `${ctx.budget.savingsCapacity} €` : `inconnue (au plus ${ctx.budget.savingsCapacityUpperBound ?? "?"} € avant les dépenses hors loyer)`}`);
  if (ctx.observedSpending) lines.push(`- Dépenses observées sur relevés (${ctx.observedSpending.months} mois) : ${ctx.observedSpending.averageMonthly} €/mois`);
  if (ctx.emergency) lines.push(`- Épargne de précaution : ${ctx.emergency.monthsCovered} mois de dépenses${ctx.emergency.expensesAreLowerBound ? " (base incomplète : loyer seul)" : ""}, niveau ${ctx.emergency.level}`);
  if (ctx.tax) lines.push(`- Tranche marginale estimée : ${Math.round(ctx.tax.marginalRate * 100)} % (revenu imposable estimé ${ctx.tax.taxable} €, ${ctx.tax.parts} part(s))`);
  lines.push("", "## Objectifs");
  for (const g of ctx.goals) lines.push(`- ${g.title} : ${g.targetAmount} € (progression ${Math.round(g.progress * 100)} %${g.monthlyContribution ? `, ${g.monthlyContribution} €/mois prévus` : ""})`);
  if (ctx.goals.length === 0) lines.push("- aucun objectif chiffré enregistré");
  if (ctx.decisions.length > 0) {
    lines.push("", "## Décisions passées");
    for (const d of ctx.decisions.slice(0, 10)) lines.push(`- ${d.date} — ${d.title} : ${d.detail}`);
  }
  if (ctx.missing.length > 0) lines.push("", `## Données manquantes : ${ctx.missing.join(" ; ")}`);
  if (ctx.stale.length > 0) lines.push("", `## Données anciennes : ${ctx.stale.join(" ; ")}`);
  return lines.join("\n");
}
