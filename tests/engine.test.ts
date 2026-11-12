import { describe, expect, it } from "vitest";
import {
  allocationAdvice, analyzePortfolio, borrowingCapacity, budgetSummary, compareRealEstateVsEtf, emergencyFund, estimateIncomeTax,
  exitTaxRate, goalPlan, monteCarlo, monthlyPayment, monthsToTarget, netWorth, project, projectScenarios, propertyGainAllowances,
  requiredMonthly, simulateLoan, simulateRental, stressTest, unemploymentRunway, type AccountLike, type HoldingLike,
} from "@/lib/engine";

const accounts: AccountLike[] = [
  { id: 1, name: "Compte courant", institution: "BoursoBank", kind: "courant", balance: 2000, asOf: "2026-11-12" },
  { id: 2, name: "LEP", institution: "BoursoBank", kind: "livret", balance: 800, asOf: "2026-11-12" },
  { id: 3, name: "PEA", institution: "BoursoBank", kind: "pea", balance: 300, asOf: "2026-11-12" },
  { id: 4, name: "Compte-titres", institution: "BoursoBank", kind: "cto", balance: 150, asOf: "2026-11-12" },
  { id: 5, name: "Autre compte-titres", institution: null, kind: "cto", balance: 4000, asOf: "2026-11-12" },
];

describe("patrimoine", () => {
  it("reproduit la situation initiale au centime", () => {
    const nw = netWorth(accounts);
    expect(nw.liquid).toBe(2800);
    expect(nw.invested).toBe(4450);
    expect(nw.total).toBe(7250);
  });
  it("déduit les crédits", () => {
    const nw = netWorth([...accounts, { id: 9, name: "Prêt", institution: null, kind: "credit", balance: -1000, asOf: "2026-01-01" }]);
    expect(nw.total).toBe(6250);
    expect(nw.oldestAsOf).toBe("2026-01-01");
  });
});

describe("budget et précaution", () => {
  it("ne calcule pas de capacité d'épargne sans les dépenses", () => {
    const b = budgetSummary({ netMonthlyIncome: 2700, rent: 700, otherExpenses: null });
    expect(b.savingsCapacity).toBeNull();
    expect(b.savingsCapacityUpperBound).toBe(2000);
    expect(b.missing).toContain("dépenses mensuelles hors loyer");
  });
  it("calcule capacité et taux d'épargne quand tout est connu", () => {
    const b = budgetSummary({ netMonthlyIncome: 2700, rent: 700, otherExpenses: 900 });
    expect(b.savingsCapacity).toBe(1100);
    expect(b.savingsRate).toBeCloseTo(0.407, 3);
  });
  it("mesure l'épargne de précaution et signale une base incomplète", () => {
    const partial = emergencyFund(2800, budgetSummary({ netMonthlyIncome: 2700, rent: 700, otherExpenses: null }))!;
    expect(partial.expensesAreLowerBound).toBe(true);
    const full = emergencyFund(2800, budgetSummary({ netMonthlyIncome: 2700, rent: 700, otherExpenses: 900 }))!;
    expect(full.monthsCovered).toBe(1.75);
    expect(full.level).toBe("insuffisante");
    expect(full.gapToMin).toBeCloseTo(4800 - 2800, 2);
  });
});

describe("crédit", () => {
  it("calcule une mensualité à taux nul", () => {
    expect(monthlyPayment(120000, 0, 10)).toBeCloseTo(1000, 6);
  });
  it("calcule une mensualité selon la formule d'annuité", () => {
    expect(monthlyPayment(200000, 0.036, 20)).toBeCloseTo(1170.22, 0);
  });
  it("amortit intégralement le capital", () => {
    const loan = simulateLoan({ principal: 150000, annualRate: 0.034, years: 25, insuranceRate: 0.003 });
    expect(loan.schedule).toHaveLength(25);
    expect(loan.schedule.at(-1)!.remaining).toBe(0);
    expect(loan.schedule.reduce((a, y) => a + y.principalRepaid, 0)).toBeCloseTo(150000, 0);
    expect(loan.monthlyInsurance).toBe(37.5);
    expect(loan.totalInterest).toBeCloseTo(loan.monthlyPayment * 300 - 150000, -1);
  });
  it("applique la règle des 35 % d'endettement", () => {
    const cap = borrowingCapacity({ netMonthlyIncome: 2700, existingMonthlyCharges: 700 });
    expect(cap.maxMonthlyPayment).toBe(245);
    const withRent = borrowingCapacity({ netMonthlyIncome: 2700, existingMonthlyCharges: 700, expectedMonthlyRent: 600 });
    expect(withRent.maxMonthlyPayment).toBe(392);
    expect(withRent.maxPrincipal).toBeGreaterThan(cap.maxPrincipal);
  });
});

describe("projection", () => {
  it("sans rendement ni frais, la valeur égale les versements", () => {
    const p = project({ initial: 1000, monthly: 100, years: 5, annualReturn: 0, annualFees: 0 });
    expect(p.final.value).toBe(7000);
    expect(p.exitTax).toBe(0);
  });
  it("correspond à la formule fermée des versements programmés", () => {
    const p = project({ initial: 0, monthly: 600, years: 10, annualReturn: 0.06, annualFees: 0 });
    const r = Math.pow(1.06, 1 / 12) - 1;
    expect(p.final.value).toBeCloseTo(600 * ((Math.pow(1 + r, 120) - 1) / r) * (1 + r), 0);
    expect(p.final.contributed).toBe(72000);
  });
  it("taxe les gains selon l'enveloppe et son ancienneté", () => {
    expect(exitTaxRate("CTO", 10)).toBeCloseTo(0.314, 6);
    expect(exitTaxRate("PEA", 3)).toBeCloseTo(0.314, 6);
    expect(exitTaxRate("PEA", 5)).toBeCloseTo(0.186, 6);
    expect(exitTaxRate("LIVRET", 1)).toBe(0);
    const pea = project({ initial: 0, monthly: 600, years: 10, annualReturn: 0.06 });
    const cto = project({ initial: 0, monthly: 600, years: 10, annualReturn: 0.06, wrapper: "CTO" });
    expect(pea.final.netValue).toBeGreaterThan(cto.final.netValue);
    expect(pea.final.realNetValue).toBeLessThan(pea.final.netValue);
  });
  it("ordonne les scénarios", () => {
    const s = projectScenarios({ initial: 0, monthly: 600, years: 10 });
    expect(s.prudent.final.netValue).toBeLessThan(s.central.final.netValue);
    expect(s.central.final.netValue).toBeLessThan(s.favorable.final.netValue);
  });
  it("résout durée et versement nécessaires de façon cohérente", () => {
    const monthly = requiredMonthly(7250, 100000, 10, 0.06);
    const months = monthsToTarget(7250, monthly, 100000, 0.06)!;
    expect(months).toBeGreaterThanOrEqual(119);
    expect(months).toBeLessThanOrEqual(120);
    expect(monthsToTarget(100, 0, 1_000_000, 0)).toBeNull();
  });
  it("refuse les paramètres absurdes", () => {
    expect(() => project({ initial: -1, monthly: 0, years: 1, annualReturn: 0.05 })).toThrow();
    expect(() => project({ initial: 0, monthly: 0, years: 0, annualReturn: 0.05 })).toThrow();
  });
});

describe("Monte-Carlo", () => {
  it("est reproductible à graine identique", () => {
    const a = monteCarlo({ initial: 5000, monthly: 600, years: 10, paths: 500, seed: 42 });
    const b = monteCarlo({ initial: 5000, monthly: 600, years: 10, paths: 500, seed: 42 });
    expect(a).toEqual(b);
  });
  it("produit une fourchette ordonnée et centrée près de la projection déterministe", () => {
    const mc = monteCarlo({ initial: 0, monthly: 600, years: 10, paths: 4000, target: 100000 });
    expect(mc.final.p10).toBeLessThan(mc.final.p50);
    expect(mc.final.p50).toBeLessThan(mc.final.p90);
    const det = project({ initial: 0, monthly: 600, years: 10, annualReturn: 0.06 }).final.value;
    expect(Math.abs(mc.final.p50 - det) / det).toBeLessThan(0.1);
    expect(mc.probabilityOfTarget).toBeGreaterThan(0);
    expect(mc.probabilityOfTarget).toBeLessThan(1);
    expect(mc.medianMaxDrawdown).toBeGreaterThan(0.1);
  });
});

describe("immobilier", () => {
  const base = { price: 120000, downPayment: 15000, monthlyRent: 650, marginalTaxRate: 0.3, years: 20 } as const;
  it("calcule rendement, crédit et trésorerie", () => {
    const r = simulateRental(base);
    expect(r.totalCost).toBe(129600);
    expect(r.loanPrincipal).toBe(114600);
    expect(r.grossYield).toBeCloseTo(7800 / 129600, 3);
    expect(r.netYield).toBeLessThan(r.grossYield);
    expect(r.years).toHaveLength(20);
    expect(r.years[0]!.rent).toBe(650 * 11);
  });
  it("le régime réel réduit l'impôt quand les intérêts sont élevés", () => {
    const micro = simulateRental(base);
    const reel = simulateRental({ ...base, regime: "reel" });
    expect(reel.years[0]!.tax).toBeLessThan(micro.years[0]!.tax);
  });
  it("applique les abattements de plus-value pour durée de détention", () => {
    expect(propertyGainAllowances(5)).toEqual({ ir: 0, ps: 0 });
    expect(propertyGainAllowances(22).ir).toBeCloseTo(1, 6);
    expect(propertyGainAllowances(30).ps).toBeCloseTo(1, 6);
  });
  it("compare immobilier et ETF sur trois scénarios à effort identique", () => {
    const c = compareRealEstateVsEtf({ rental: base, units: 2 });
    expect(c.scenarios.map((s) => s.scenario)).toEqual(["prudent", "central", "favorable"]);
    expect(c.downPayment).toBe(30000);
    expect(c.totalDebt).toBe(229200);
    expect(c.series).toHaveLength(20);
    for (const s of c.scenarios) expect(Number.isFinite(s.difference)).toBe(true);
  });
  it("refuse un apport supérieur au coût", () => {
    expect(() => simulateRental({ ...base, downPayment: 500000 })).toThrow();
  });
});

describe("portefeuille et résistance", () => {
  const holdings: HoldingLike[] = [
    { id: 1, accountId: 5, name: "Apple", ticker: "AAPL", assetClass: "action", sector: "Technologie", value: 1500, asOf: "2026-11-12" },
    { id: 2, accountId: 5, name: "ETF S&P 500", ticker: null, assetClass: "etf", sector: null, value: 500, asOf: "2026-11-12" },
    { id: 3, accountId: null, name: "Toosla", ticker: null, assetClass: "action", sector: null, value: null, asOf: null },
  ];
  it("mesure la concentration sans inventer de valeur", () => {
    const a = analyzePortfolio(accounts, holdings);
    expect(a.investedTotal).toBe(4450);
    expect(a.detailedValue).toBe(2000);
    expect(a.topLine?.name).toBe("Apple");
    expect(a.topLine?.weight).toBe(0.75);
    expect(a.holdingsWithoutValue).toEqual(["Toosla"]);
    expect(a.flags.some((f) => f.includes("Composition connue"))).toBe(true);
    expect(a.flags.some((f) => f.includes("Apple"))).toBe(true);
  });
  it("chiffre les pertes en cas de krach", () => {
    const { scenarios } = stressTest(accounts, 1);
    expect(scenarios).toHaveLength(3);
    expect(scenarios[1]!.loss).toBeCloseTo(4450 * 0.525, 1);
    expect(scenarios[2]!.netWorthAfter).toBeLessThan(scenarios[0]!.netWorthAfter);
    expect(scenarios[2]!.recoveryYears).toBeGreaterThan(scenarios[0]!.recoveryYears);
  });
  it("calcule la durée tenable sans emploi", () => {
    const r = unemploymentRunway({ liquid: 2800, invested: 4450, monthlyExpenses: 1600, netMonthlyIncome: 2700, months: 6 });
    expect(r.cases[0]!.monthlyShortfall).toBe(0);
    expect(r.cases[0]!.monthsOnLiquid).toBeNull();
    expect(r.cases[1]!.monthsOnLiquid).toBe(1.75);
    expect(r.cases[1]!.survivesPeriod).toBe(false);
  });
});

describe("objectif et allocation", () => {
  it("planifie l'atteinte de 100 000 €", () => {
    const plan = goalPlan(7250, 600, 100000);
    expect(plan.byScenario.favorable.months!).toBeLessThan(plan.byScenario.prudent.months!);
    expect(plan.withoutReturnMonths).toBe(Math.ceil((100000 - 7250) / 600));
    expect(plan.progress).toBeCloseTo(0.0725, 2);
  });
  it("ne recommande pas d'investir quand les dépenses sont inconnues", () => {
    const advice = allocationAdvice({ amount: 1000, emergency: null, lepBalance: 800, hasLep: true, portfolioFlags: [], expensesKnown: false });
    expect(advice.recommendedId).toBe("securite");
    expect(advice.reasoning[0]).toMatch(/dépenses mensuelles sont inconnues/);
  });
  it("recommande la sécurité quand la précaution est insuffisante", () => {
    const emergency = emergencyFund(2800, budgetSummary({ netMonthlyIncome: 2700, rent: 700, otherExpenses: 900 }));
    const advice = allocationAdvice({ amount: 1000, emergency, lepBalance: 800, hasLep: true, portfolioFlags: [], expensesKnown: true });
    expect(advice.recommendedId).toBe("securite");
    expect(advice.options.filter((o) => o.recommended)).toHaveLength(1);
  });
  it("recommande d'investir quand la précaution est confortable", () => {
    const emergency = emergencyFund(12000, budgetSummary({ netMonthlyIncome: 2700, rent: 700, otherExpenses: 900 }));
    const advice = allocationAdvice({ amount: 1000, emergency, lepBalance: 800, hasLep: true, portfolioFlags: [], expensesKnown: true });
    expect(advice.recommendedId).toBe("investir");
    const etf = advice.options.find((o) => o.id === "investir")!;
    expect(etf.valueIn5Years.low).toBeLessThan(etf.valueIn5Years.high);
  });
});

describe("fiscalité", () => {
  it("estime l'impôt et la tranche marginale", () => {
    const t = estimateIncomeTax(32400);
    expect(t.taxable).toBe(29160);
    expect(t.marginalRate).toBe(0.11);
    expect(t.tax).toBe(Math.round((29160 - 11600) * 0.11));
    expect(estimateIncomeTax(60000).marginalRate).toBe(0.3);
  });
});
