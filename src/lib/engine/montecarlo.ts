import { round2 } from "./money";
import { MARKET } from "./params";

/** Générateur pseudo-aléatoire déterministe (mulberry32) : même graine, mêmes résultats. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tirage gaussien centré réduit (Box-Muller). */
function gaussian(rand: () => number): number {
  let u = 0;
  while (u === 0) u = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

export interface MonteCarloInput {
  initial: number;
  monthly: number;
  years: number;
  expectedReturn?: number;
  volatility?: number;
  annualFees?: number;
  paths?: number;
  seed?: number;
  target?: number;
}

export interface MonteCarloYear {
  year: number;
  p10: number;
  p50: number;
  p90: number;
  contributed: number;
}

export interface MonteCarloResult {
  years: MonteCarloYear[];
  final: { p10: number; p50: number; p90: number; contributed: number };
  /** Part des trajectoires terminant sous le total versé. */
  probabilityOfLoss: number;
  /** Part des trajectoires atteignant la cible (si fournie). */
  probabilityOfTarget: number | null;
  /** Pire baisse médiane entre un sommet et un creux, sur l'ensemble des trajectoires. */
  medianMaxDrawdown: number;
  paths: number;
  seed: number;
}

const percentile = (sorted: number[], q: number): number => {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
};

/**
 * Simulation de rendements variables (loi log-normale, tirages mensuels indépendants).
 * Limites assumées : pas de queues épaisses ni de corrélation temporelle — les krachs réels
 * peuvent être plus violents ; c'est pourquoi le test de résistance existe séparément.
 */
export function monteCarlo(input: MonteCarloInput): MonteCarloResult {
  const expectedReturn = input.expectedReturn ?? MARKET.scenarios.value.central;
  const volatility = input.volatility ?? MARKET.volatility.value;
  const fees = input.annualFees ?? MARKET.etfFees.value;
  const paths = Math.min(Math.max(input.paths ?? 2000, 100), 20000);
  const seed = input.seed ?? 20261112;
  const months = Math.round(input.years * 12);
  const rand = mulberry32(seed);

  // Paramètres mensuels du log-rendement, calés sur l'espérance arithmétique annuelle nette de frais.
  const sigmaM = volatility / Math.sqrt(12);
  const muM = Math.log(1 + expectedReturn - fees) / 12 - (sigmaM * sigmaM) / 2;

  const yearCount = Math.ceil(months / 12);
  const byYear: number[][] = Array.from({ length: yearCount }, () => []);
  const drawdowns: number[] = [];
  const contributedFinal = input.initial + input.monthly * months;
  let losses = 0;
  let hits = 0;

  for (let pIdx = 0; pIdx < paths; pIdx++) {
    let value = input.initial;
    let peak = value;
    let maxDd = 0;
    for (let m = 1; m <= months; m++) {
      value = (value + input.monthly) * Math.exp(muM + sigmaM * gaussian(rand));
      if (value > peak) peak = value;
      else if (peak > 0) maxDd = Math.max(maxDd, 1 - value / peak);
      if (m % 12 === 0 || m === months) byYear[Math.ceil(m / 12) - 1]!.push(value);
    }
    drawdowns.push(maxDd);
    if (value < contributedFinal) losses++;
    if (input.target !== undefined && value >= input.target) hits++;
  }

  const years: MonteCarloYear[] = byYear.map((values, i) => {
    values.sort((a, b) => a - b);
    const y = Math.min(i + 1, months / 12);
    return {
      year: round2(y),
      p10: round2(percentile(values, 0.1)),
      p50: round2(percentile(values, 0.5)),
      p90: round2(percentile(values, 0.9)),
      contributed: round2(input.initial + input.monthly * Math.min((i + 1) * 12, months)),
    };
  });
  drawdowns.sort((a, b) => a - b);
  const last = years[years.length - 1]!;

  return {
    years,
    final: { p10: last.p10, p50: last.p50, p90: last.p90, contributed: last.contributed },
    probabilityOfLoss: round2(losses / paths),
    probabilityOfTarget: input.target !== undefined ? round2(hits / paths) : null,
    medianMaxDrawdown: round2(percentile(drawdowns, 0.5)),
    paths,
    seed,
  };
}
