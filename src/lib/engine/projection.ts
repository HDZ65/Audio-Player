import { assertFinitePositive, monthlyRate, round2 } from "./money";
import { MARKET, SAVINGS, SCENARIO_NAMES, TAX, type ScenarioName } from "./params";

export type Wrapper = "PEA" | "CTO" | "LIVRET";

export interface ProjectionInput {
  initial: number;
  monthly: number;
  years: number;
  /** Rendement annuel nominal avant frais. */
  annualReturn: number;
  annualFees?: number;
  inflation?: number;
  wrapper?: Wrapper;
  /** Ancienneté actuelle de l'enveloppe, en années (utile pour le PEA). */
  wrapperAgeYears?: number;
}

export interface ProjectionPoint {
  year: number;
  contributed: number;
  /** Valeur brute avant fiscalité de sortie. */
  value: number;
  /** Valeur si tout était vendu cette année-là, après impôts et prélèvements sociaux. */
  netValue: number;
  /** Valeur nette exprimée en euros d'aujourd'hui. */
  realNetValue: number;
}

export interface ProjectionResult {
  input: Required<ProjectionInput>;
  points: ProjectionPoint[];
  final: ProjectionPoint;
  totalGain: number;
  exitTax: number;
}

/** Taux de taxation des plus-values à la sortie, selon l'enveloppe et son ancienneté. */
export function exitTaxRate(wrapper: Wrapper, wrapperAgeAtExit: number): number {
  if (wrapper === "LIVRET") return 0;
  if (wrapper === "PEA" && wrapperAgeAtExit >= TAX.peaExemptionYears.value) return TAX.psCapital.value;
  return TAX.pfuIR.value + TAX.psCapital.value;
}

/**
 * Projection déterministe d'un investissement programmé.
 * Les versements ont lieu en début de mois ; les frais sont prélevés sur le rendement.
 */
export function project(input: ProjectionInput): ProjectionResult {
  const full: Required<ProjectionInput> = {
    initial: input.initial,
    monthly: input.monthly,
    years: input.years,
    annualReturn: input.annualReturn,
    annualFees: input.annualFees ?? MARKET.etfFees.value,
    inflation: input.inflation ?? MARKET.inflation.value,
    wrapper: input.wrapper ?? "PEA",
    wrapperAgeYears: input.wrapperAgeYears ?? 0,
  };
  assertFinitePositive("capital initial", full.initial);
  assertFinitePositive("versement mensuel", full.monthly);
  assertFinitePositive("durée", full.years, false);
  if (full.years > 60) throw new RangeError("Durée de projection limitée à 60 ans");
  if (!Number.isFinite(full.annualReturn) || full.annualReturn <= -1) throw new RangeError("Rendement invalide");

  const r = monthlyRate(full.annualReturn - full.annualFees);
  const months = Math.round(full.years * 12);
  const points: ProjectionPoint[] = [{ year: 0, contributed: round2(full.initial), value: round2(full.initial), netValue: round2(full.initial), realNetValue: round2(full.initial) }];

  let value = full.initial;
  let contributed = full.initial;
  for (let m = 1; m <= months; m++) {
    value = (value + full.monthly) * (1 + r);
    contributed += full.monthly;
    if (m % 12 === 0 || m === months) {
      const year = m / 12;
      const gain = Math.max(0, value - contributed);
      const tax = gain * exitTaxRate(full.wrapper, full.wrapperAgeYears + year);
      const netValue = value - tax;
      points.push({
        year: round2(year),
        contributed: round2(contributed),
        value: round2(value),
        netValue: round2(netValue),
        realNetValue: round2(netValue / Math.pow(1 + full.inflation, year)),
      });
    }
  }

  const final = points[points.length - 1]!;
  return { input: full, points, final, totalGain: round2(final.value - final.contributed), exitTax: round2(final.value - final.netValue) };
}

export type ScenarioSet = Record<ScenarioName, ProjectionResult>;

/** Trois scénarios lus ensemble : jamais un résultat unique artificiellement précis. */
export function projectScenarios(input: Omit<ProjectionInput, "annualReturn">, returns: Record<ScenarioName, number> = MARKET.scenarios.value): ScenarioSet {
  const out = {} as ScenarioSet;
  for (const name of SCENARIO_NAMES) out[name] = project({ ...input, annualReturn: returns[name] });
  return out;
}

/** Projection d'un livret réglementé (intérêts nets d'impôt), plafonné. */
export function projectSavingsAccount(initial: number, monthly: number, years: number, rate: number = SAVINGS.lep.value, ceiling: number = SAVINGS.lepCeiling.value): { final: number; interest: number; cappedAtYear: number | null } {
  const r = monthlyRate(rate);
  let balance = initial;
  let deposits = initial;
  let cappedAtYear: number | null = null;
  for (let m = 1; m <= Math.round(years * 12); m++) {
    const room = Math.max(0, ceiling - balance);
    const deposit = Math.min(monthly, room);
    if (deposit < monthly && cappedAtYear === null) cappedAtYear = Math.ceil(m / 12);
    balance = (balance + deposit) * (1 + r);
    deposits += deposit;
  }
  return { final: round2(balance), interest: round2(balance - deposits), cappedAtYear };
}

/** Nombre de mois nécessaires pour atteindre une cible (null si hors d'atteinte en 60 ans). */
export function monthsToTarget(current: number, monthly: number, target: number, annualReturn: number, annualFees: number = MARKET.etfFees.value): number | null {
  if (current >= target) return 0;
  const r = monthlyRate(annualReturn - annualFees);
  let value = current;
  for (let m = 1; m <= 720; m++) {
    value = (value + monthly) * (1 + r);
    if (value >= target) return m;
  }
  return null;
}

/** Versement mensuel nécessaire pour atteindre une cible en un nombre d'années donné. */
export function requiredMonthly(current: number, target: number, years: number, annualReturn: number, annualFees: number = MARKET.etfFees.value): number {
  const r = monthlyRate(annualReturn - annualFees);
  const n = Math.round(years * 12);
  const growth = Math.pow(1 + r, n);
  const futureOfCurrent = current * growth;
  if (futureOfCurrent >= target) return 0;
  const annuityFactor = r === 0 ? n : ((growth - 1) / r) * (1 + r);
  return round2((target - futureOfCurrent) / annuityFactor);
}
