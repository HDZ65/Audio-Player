import { round2, sum } from "./money";
import { MARKET, SAFETY, SAVINGS } from "./params";
import { monthsToTarget, projectSavingsAccount, projectScenarios, requiredMonthly } from "./projection";
import { INVESTMENT_KINDS, LIQUID_KINDS, type AccountLike, type HoldingLike } from "./types";
import { SCENARIO_NAMES, type ScenarioName } from "./params";

/* ───────────── Patrimoine ───────────── */

export interface NetWorth {
  total: number;
  liquid: number;
  invested: number;
  realEstate: number;
  other: number;
  debts: number;
  /** Date la plus ancienne parmi les soldes : le total n'est pas plus frais que sa donnée la plus vieille. */
  oldestAsOf: string | null;
}

export function netWorth(accounts: readonly AccountLike[]): NetWorth {
  const of = (kinds: readonly string[]) => sum(accounts.filter((a) => kinds.includes(a.kind)).map((a) => a.balance));
  const liquid = of(LIQUID_KINDS);
  const invested = of(INVESTMENT_KINDS);
  const realEstate = of(["immobilier"]);
  const other = of(["autre"]);
  const debts = sum(accounts.filter((a) => a.kind === "credit").map((a) => Math.abs(a.balance)));
  const dates = accounts.map((a) => a.asOf).sort();
  return {
    total: round2(liquid + invested + realEstate + other - debts),
    liquid: round2(liquid),
    invested: round2(invested),
    realEstate: round2(realEstate),
    other: round2(other),
    debts: round2(debts),
    oldestAsOf: dates[0] ?? null,
  };
}

/* ───────────── Budget ───────────── */

export interface BudgetInput {
  netMonthlyIncome: number | null;
  rent: number | null;
  /** Dépenses mensuelles hors loyer ; null si non renseignées. */
  otherExpenses: number | null;
}

export interface BudgetSummary {
  income: number | null;
  knownExpenses: number;
  totalExpenses: number | null;
  /** Capacité d'épargne mensuelle ; null tant que les dépenses sont inconnues. */
  savingsCapacity: number | null;
  /** Majorant : revenu − charges connues. La vraie capacité est inférieure ou égale. */
  savingsCapacityUpperBound: number | null;
  savingsRate: number | null;
  missing: string[];
}

export function budgetSummary(input: BudgetInput): BudgetSummary {
  const missing: string[] = [];
  if (input.netMonthlyIncome === null) missing.push("revenu mensuel net");
  if (input.rent === null) missing.push("loyer");
  if (input.otherExpenses === null) missing.push("dépenses mensuelles hors loyer");
  const knownExpenses = (input.rent ?? 0) + (input.otherExpenses ?? 0);
  const complete = input.otherExpenses !== null && input.rent !== null;
  const totalExpenses = complete ? knownExpenses : null;
  const savingsCapacity = input.netMonthlyIncome !== null && totalExpenses !== null ? round2(input.netMonthlyIncome - totalExpenses) : null;
  return {
    income: input.netMonthlyIncome,
    knownExpenses: round2(knownExpenses),
    totalExpenses,
    savingsCapacity,
    savingsCapacityUpperBound: input.netMonthlyIncome !== null ? round2(input.netMonthlyIncome - knownExpenses) : null,
    savingsRate: savingsCapacity !== null && input.netMonthlyIncome ? round2((savingsCapacity / input.netMonthlyIncome) * 1000) / 1000 : null,
    missing,
  };
}

export interface EmergencyFund {
  liquid: number;
  monthlyExpenses: number;
  /** true si les dépenses sont une estimation basse (loyer seul connu). */
  expensesAreLowerBound: boolean;
  monthsCovered: number;
  targetMin: number;
  targetComfort: number;
  gapToMin: number;
  gapToComfort: number;
  level: "insuffisante" | "minimale" | "confortable";
}

export function emergencyFund(liquid: number, budget: BudgetSummary): EmergencyFund | null {
  const monthlyExpenses = budget.totalExpenses ?? (budget.knownExpenses > 0 ? budget.knownExpenses : null);
  if (monthlyExpenses === null || monthlyExpenses <= 0) return null;
  const targetMin = monthlyExpenses * SAFETY.emergencyMonthsMin.value;
  const targetComfort = monthlyExpenses * SAFETY.emergencyMonthsComfort.value;
  const monthsCovered = liquid / monthlyExpenses;
  return {
    liquid: round2(liquid),
    monthlyExpenses: round2(monthlyExpenses),
    expensesAreLowerBound: budget.totalExpenses === null,
    monthsCovered: round2(monthsCovered),
    targetMin: round2(targetMin),
    targetComfort: round2(targetComfort),
    gapToMin: round2(Math.max(0, targetMin - liquid)),
    gapToComfort: round2(Math.max(0, targetComfort - liquid)),
    level: liquid < targetMin ? "insuffisante" : liquid < targetComfort ? "minimale" : "confortable",
  };
}

/* ───────────── Portefeuille ───────────── */

export interface PortfolioLine {
  name: string;
  value: number;
  weight: number;
  assetClass: string;
  sector: string | null;
}

export interface PortfolioAnalysis {
  investedTotal: number;
  /** Part des placements dont la composition ligne à ligne est connue. */
  detailedValue: number;
  undetailedValue: number;
  coverage: number;
  lines: PortfolioLine[];
  holdingsWithoutValue: string[];
  byAssetClass: { label: string; value: number; weight: number }[];
  bySector: { label: string; value: number; weight: number }[];
  byAccount: { label: string; value: number; weight: number }[];
  topLine: PortfolioLine | null;
  /** Indice de Herfindahl sur les lignes détaillées (1 = une seule ligne). */
  concentrationIndex: number | null;
  singleStockShare: number | null;
  riskyShareOfNetWorth: number;
  flags: string[];
}

const groupBy = (lines: PortfolioLine[], key: (l: PortfolioLine) => string, total: number) => {
  const map = new Map<string, number>();
  for (const l of lines) map.set(key(l), (map.get(key(l)) ?? 0) + l.value);
  return [...map.entries()]
    .map(([label, value]) => ({ label, value: round2(value), weight: total > 0 ? round2((value / total) * 1000) / 1000 : 0 }))
    .sort((a, b) => b.value - a.value);
};

export function analyzePortfolio(accounts: readonly AccountLike[], holdings: readonly HoldingLike[]): PortfolioAnalysis {
  const investmentAccounts = accounts.filter((a) => INVESTMENT_KINDS.includes(a.kind));
  const investedTotal = sum(investmentAccounts.map((a) => a.balance));
  const valued = holdings.filter((h): h is HoldingLike & { value: number } => h.value !== null && h.value > 0);
  const detailedValue = Math.min(investedTotal, sum(valued.map((h) => h.value)));
  const base = sum(valued.map((h) => h.value));

  const lines: PortfolioLine[] = valued
    .map((h) => ({ name: h.name, value: round2(h.value), weight: base > 0 ? round2((h.value / base) * 1000) / 1000 : 0, assetClass: h.assetClass, sector: h.sector }))
    .sort((a, b) => b.value - a.value);

  const flags: string[] = [];
  const coverage = investedTotal > 0 ? detailedValue / investedTotal : 0;
  const holdingsWithoutValue = holdings.filter((h) => h.value === null).map((h) => h.name);
  if (investedTotal > 0 && coverage < 0.8) {
    flags.push(`Composition connue pour ${Math.round(coverage * 100)} % des placements seulement : l'analyse de diversification est partielle.`);
  }
  const topLine = lines[0] ?? null;
  if (topLine && topLine.weight > SAFETY.concentrationWarn.value && lines.length > 1) {
    flags.push(`${topLine.name} pèse ${Math.round(topLine.weight * 100)} % des lignes valorisées.`);
  }
  const stocks = lines.filter((l) => l.assetClass === "action");
  const singleStockShare = base > 0 ? sum(stocks.map((l) => l.value)) / base : null;
  const allHoldingsAreStocks = holdings.length > 0 && holdings.filter((h) => h.assetClass === "action").length / holdings.length > 0.7;
  if ((singleStockShare !== null && singleStockShare > 0.6) || (base === 0 && allHoldingsAreStocks)) {
    flags.push("Portefeuille majoritairement composé d'actions individuelles : risque spécifique élevé par rapport à un indice diversifié.");
  }
  const nw = netWorth(accounts);

  return {
    investedTotal: round2(investedTotal),
    detailedValue: round2(detailedValue),
    undetailedValue: round2(Math.max(0, investedTotal - detailedValue)),
    coverage: round2(coverage * 1000) / 1000,
    lines,
    holdingsWithoutValue,
    byAssetClass: groupBy(lines, (l) => l.assetClass, base),
    bySector: groupBy(lines, (l) => l.sector ?? "non renseigné", base),
    byAccount: investmentAccounts.map((a) => ({ label: a.name, value: round2(a.balance), weight: investedTotal > 0 ? round2((a.balance / investedTotal) * 1000) / 1000 : 0 })).sort((a, b) => b.value - a.value),
    topLine,
    concentrationIndex: lines.length > 0 ? round2(sum(lines.map((l) => l.weight * l.weight)) * 1000) / 1000 : null,
    singleStockShare: singleStockShare !== null ? round2(singleStockShare * 1000) / 1000 : null,
    riskyShareOfNetWorth: nw.total > 0 ? round2((investedTotal / nw.total) * 1000) / 1000 : 0,
    flags,
  };
}

/* ───────────── Tests de résistance ───────────── */

export interface StressScenario {
  label: string;
  shock: number;
  loss: number;
  investedAfter: number;
  netWorthAfter: number;
  /** Années pour revenir au niveau initial au rendement central, sans nouveau versement. */
  recoveryYears: number;
}

export const STRESS_SHOCKS = [
  { label: "Correction (−20 %)", shock: -0.2 },
  { label: "Krach type 2020 (−35 %)", shock: -0.35 },
  { label: "Crise majeure type 2008 (−50 %)", shock: -0.5 },
] as const;

/** Les actions individuelles peuvent baisser bien plus que l'indice : on applique un facteur d'amplification. */
export function stressTest(accounts: readonly AccountLike[], singleStockShare: number | null): { scenarios: StressScenario[]; amplification: number } {
  const nw = netWorth(accounts);
  const amplification = 1 + 0.5 * (singleStockShare ?? 0.5);
  const net = MARKET.scenarios.value.central - MARKET.etfFees.value;
  const scenarios = STRESS_SHOCKS.map(({ label, shock }) => {
    const effective = Math.max(-0.95, shock * amplification);
    const loss = nw.invested * -effective;
    return {
      label,
      shock: round2(effective * 1000) / 1000,
      loss: round2(loss),
      investedAfter: round2(nw.invested - loss),
      netWorthAfter: round2(nw.total - loss),
      recoveryYears: round2(Math.log(1 / (1 + effective)) / Math.log(1 + net)),
    };
  });
  return { scenarios, amplification: round2(amplification) };
}

export interface RunwayInput {
  liquid: number;
  invested: number;
  monthlyExpenses: number;
  netMonthlyIncome: number;
  /** Durée de la perte d'emploi simulée, en mois. */
  months: number;
}

export interface RunwayCase {
  label: string;
  monthlyIncome: number;
  monthlyShortfall: number;
  /** Mois tenus avec les seules liquidités ; null = indéfiniment. */
  monthsOnLiquid: number | null;
  /** Mois tenus en vendant aussi les placements (décotés de 35 %). */
  monthsWithInvestments: number | null;
  liquidLeftAfterPeriod: number;
  survivesPeriod: boolean;
}

export function unemploymentRunway(input: RunwayInput): { cases: RunwayCase[]; haircut: number } {
  const haircut = 0.35;
  const build = (label: string, monthlyIncome: number): RunwayCase => {
    const shortfall = Math.max(0, input.monthlyExpenses - monthlyIncome);
    const monthsOnLiquid = shortfall > 0 ? input.liquid / shortfall : null;
    const monthsWithInvestments = shortfall > 0 ? (input.liquid + input.invested * (1 - haircut)) / shortfall : null;
    return {
      label,
      monthlyIncome: round2(monthlyIncome),
      monthlyShortfall: round2(shortfall),
      monthsOnLiquid: monthsOnLiquid !== null ? round2(monthsOnLiquid) : null,
      monthsWithInvestments: monthsWithInvestments !== null ? round2(monthsWithInvestments) : null,
      liquidLeftAfterPeriod: round2(input.liquid - shortfall * input.months),
      survivesPeriod: input.liquid - shortfall * input.months >= 0,
    };
  };
  return {
    cases: [
      build("Avec allocation chômage estimée", input.netMonthlyIncome * SAFETY.unemploymentReplacement.value),
      build("Sans aucun revenu", 0),
    ],
    haircut,
  };
}

/* ───────────── Objectif ───────────── */

export interface GoalPlan {
  target: number;
  current: number;
  monthly: number;
  byScenario: Record<ScenarioName, { months: number | null; years: number | null }>;
  /** Sans aucun rendement : borne prudente. */
  withoutReturnMonths: number | null;
  /** Versement mensuel nécessaire (scénario central) pour différents horizons. */
  requiredMonthly: { years: number; monthly: number }[];
  progress: number;
}

export function goalPlan(current: number, monthly: number, target: number): GoalPlan {
  const byScenario = {} as GoalPlan["byScenario"];
  for (const name of SCENARIO_NAMES) {
    const months = monthsToTarget(current, monthly, target, MARKET.scenarios.value[name]);
    byScenario[name] = { months, years: months !== null ? round2(months / 12) : null };
  }
  return {
    target,
    current: round2(current),
    monthly,
    byScenario,
    withoutReturnMonths: current >= target ? 0 : monthly > 0 ? Math.ceil((target - current) / monthly) : null,
    requiredMonthly: [5, 8, 10, 15].map((years) => ({ years, monthly: requiredMonthly(current, target, years, MARKET.scenarios.value.central) })),
    progress: target > 0 ? round2(Math.min(1, current / target) * 1000) / 1000 : 0,
  };
}

/* ───────────── « J'ai X € disponibles » ───────────── */

export interface AllocationOption {
  id: "securite" | "mixte" | "investir" | "attendre";
  title: string;
  split: { label: string; amount: number }[];
  /** Valeur estimée de la somme à 5 ans, fourchette prudent → favorable. */
  valueIn5Years: { low: number; central: number; high: number };
  pros: string[];
  cons: string[];
  recommended: boolean;
}

export interface AllocationAdvice {
  amount: number;
  options: AllocationOption[];
  recommendedId: AllocationOption["id"];
  reasoning: string[];
  uncertainties: string[];
}

export interface AllocationContext {
  amount: number;
  emergency: EmergencyFund | null;
  lepBalance: number | null;
  /** Le LEP est soumis à un plafond de revenus : éligibilité à confirmer. */
  hasLep: boolean;
  portfolioFlags: string[];
  expensesKnown: boolean;
}

export function allocationAdvice(ctx: AllocationContext): AllocationAdvice {
  const { amount, emergency } = ctx;
  const lepRoom = ctx.hasLep ? Math.max(0, SAVINGS.lepCeiling.value - (ctx.lepBalance ?? 0)) : 0;
  const safeRate = ctx.hasLep && lepRoom > 0 ? SAVINGS.lep.value : SAVINGS.livretA.value;
  const safeLabel = ctx.hasLep && lepRoom > 0 ? "LEP" : "Livret A";
  const safe5 = (x: number) => projectSavingsAccount(x, 0, 5, safeRate, Infinity).final;
  const etf5 = (x: number) => {
    const s = projectScenarios({ initial: x, monthly: 0, years: 5, wrapper: "PEA" });
    return { low: s.prudent.final.netValue, central: s.central.final.netValue, high: s.favorable.final.netValue };
  };

  const gap = emergency?.gapToMin ?? 0;
  const toSafety = Math.min(amount, gap);
  const mixSafe = emergency && gap > 0 ? toSafety : round2(amount / 2);
  const mixEtf = round2(amount - mixSafe);
  const e = etf5(amount);
  const m = etf5(mixEtf);

  const options: AllocationOption[] = [
    {
      id: "securite",
      title: `Renforcer l'épargne de précaution (${safeLabel})`,
      split: [{ label: safeLabel, amount }],
      valueIn5Years: { low: safe5(amount), central: safe5(amount), high: safe5(amount) },
      pros: ["Capital garanti et disponible à tout moment", `Intérêts nets d'impôt (${(safeRate * 100).toFixed(1).replace(".", ",")} % actuellement)`, "Réduit le risque de devoir vendre des placements au mauvais moment"],
      cons: ["Rendement proche de l'inflation : peu de création de richesse", "Le taux est révisable deux fois par an"],
      recommended: false,
    },
    {
      id: "mixte",
      title: "Répartir entre sécurité et ETF diversifié",
      split: [
        { label: safeLabel, amount: mixSafe },
        { label: "ETF Monde (PEA)", amount: mixEtf },
      ],
      valueIn5Years: { low: round2(safe5(mixSafe) + m.low), central: round2(safe5(mixSafe) + m.central), high: round2(safe5(mixSafe) + m.high) },
      pros: ["Comble d'abord le manque de précaution, investit le reste", "Diversifie un portefeuille concentré sur des actions individuelles"],
      cons: ["La part investie peut baisser fortement à court terme", "Montant investi modeste : effet limité sur le patrimoine"],
      recommended: false,
    },
    {
      id: "investir",
      title: "Tout investir en ETF Monde via le PEA",
      split: [{ label: "ETF Monde (PEA)", amount }],
      valueIn5Years: e,
      pros: ["Espérance de rendement la plus élevée à long terme", "Fiscalité allégée du PEA après 5 ans", "Très large diversification, frais faibles"],
      cons: ["Perte possible de 30 à 50 % en cas de krach", "À n'envisager que pour de l'argent non nécessaire avant 5 à 8 ans"],
      recommended: false,
    },
    {
      id: "attendre",
      title: "Ne rien investir pour l'instant",
      split: [{ label: "Compte courant", amount }],
      valueIn5Years: { low: amount, central: amount, high: amount },
      pros: ["Disponibilité totale si une dépense imprévue ou connue arrive", "Aucun risque de perte en capital"],
      cons: ["Aucun rendement : l'inflation érode le pouvoir d'achat", "Reporte la décision sans la résoudre"],
      recommended: false,
    },
  ];

  const reasoning: string[] = [];
  const uncertainties: string[] = [];
  let recommendedId: AllocationOption["id"];

  if (!emergency || emergency.expensesAreLowerBound) {
    // Dépenses inconnues : on ne peut pas dire quelle part est investissable. Le livret ne ferme aucune porte.
    recommendedId = "securite";
    reasoning.push(`Tes dépenses mensuelles sont inconnues : je ne peux pas dimensionner ton épargne de précaution, donc pas dire quelle part de cette somme peut être investie sans risque. En attendant, le ${safeLabel} la rémunère sans la bloquer : tu pourras l'investir dès que ta situation sera claire.`);
  } else if (gap >= amount) {
    recommendedId = "securite";
    reasoning.push(`Ton épargne disponible couvre ${emergency.monthsCovered.toFixed(1).replace(".", ",")} mois de dépenses, sous le minimum de ${SAFETY.emergencyMonthsMin.value} mois : il manque ${Math.round(gap)} €, plus que la somme disponible.`);
  } else if (gap > 0) {
    recommendedId = "mixte";
    reasoning.push(`Il manque ${Math.round(gap)} € pour atteindre ${SAFETY.emergencyMonthsMin.value} mois de dépenses de précaution : on comble d'abord ce manque, le reste peut être investi.`);
  } else {
    recommendedId = emergency.level === "confortable" ? "investir" : "mixte";
    reasoning.push(`Ton épargne de précaution couvre ${emergency.monthsCovered.toFixed(1).replace(".", ",")} mois de dépenses : le minimum est atteint, cette somme peut travailler à long terme.`);
  }
  if (emergency?.expensesAreLowerBound) {
    uncertainties.push("Seul ton loyer est connu : tes dépenses réelles sont plus élevées, donc ton besoin de précaution aussi. La recommandation est probablement trop optimiste.");
  }
  if (!ctx.expensesKnown) uncertainties.push("Sans tes dépenses à venir, je ne peux pas vérifier que cette somme n'est pas déjà « réservée ».");
  if (ctx.hasLep) uncertainties.push("Le LEP est réservé aux foyers sous un plafond de revenu fiscal de référence : ton éligibilité est à vérifier chaque année avec ton avis d'imposition.");
  if (ctx.portfolioFlags.length > 0) reasoning.push("Ton portefeuille est concentré sur des actions individuelles : tout nouvel investissement gagne à aller vers un support diversifié plutôt que vers une ligne supplémentaire.");
  uncertainties.push("Les valeurs à 5 ans sont des simulations (scénarios prudent, central, favorable), pas des prévisions ni des garanties.");

  for (const o of options) o.recommended = o.id === recommendedId;
  return { amount, options, recommendedId, reasoning, uncertainties };
}
