import { monthlyRate, round2 } from "./money";
import { MARKET, SCENARIO_NAMES, type ScenarioName } from "./params";
import { exitTaxRate, type Wrapper } from "./projection";
import { simulateRental, type RentalInput, type RentalResult } from "./realestate";

export interface CompareInput {
  rental: RentalInput;
  /** Nombre de biens identiques achetés. */
  units?: number;
  wrapper?: Wrapper;
  /** Variation du prix de l'immobilier par scénario. */
  priceGrowth?: Record<ScenarioName, number>;
  marketReturns?: Record<ScenarioName, number>;
}

export interface CompareScenario {
  scenario: ScenarioName;
  realEstateNetWorth: number;
  etfNetWorth: number;
  difference: number;
  winner: "immobilier" | "etf" | "equivalent";
}

export interface CompareResult {
  units: number;
  years: number;
  downPayment: number;
  averageMonthlyEffort: number;
  totalDebt: number;
  scenarios: CompareScenario[];
  series: { year: number; immobilier: number; etf: number }[];
  rentalCentral: RentalResult;
  notes: string[];
}

const DEFAULT_PRICE_GROWTH: Record<ScenarioName, number> = { prudent: -0.005, central: 0.01, favorable: 0.025 };

/**
 * Compare, à effort financier identique, un investissement locatif à crédit et un ETF.
 * L'investisseur ETF place le même apport au départ, puis chaque année la même somme
 * que celle que l'immobilier lui aurait coûtée (ou retire ce que l'immobilier aurait rapporté).
 */
export function compareRealEstateVsEtf(input: CompareInput): CompareResult {
  const units = Math.max(1, Math.round(input.units ?? 1));
  const wrapper = input.wrapper ?? "PEA";
  const priceGrowth = input.priceGrowth ?? DEFAULT_PRICE_GROWTH;
  const marketReturns = input.marketReturns ?? MARKET.scenarios.value;
  const years = input.rental.years;

  const scenarios: CompareScenario[] = [];
  let series: CompareResult["series"] = [];
  let rentalCentral: RentalResult | null = null;

  for (const scenario of SCENARIO_NAMES) {
    const rental = simulateRental({ ...input.rental, priceGrowth: priceGrowth[scenario] });
    const r = monthlyRate(marketReturns[scenario] - MARKET.etfFees.value);

    let etf = rental.cashInvested * units;
    let contributed = etf;
    const etfByYear: number[] = [];
    for (const y of rental.years) {
      const monthlyContribution = (-y.cashFlow * units) / 12;
      for (let m = 0; m < 12; m++) {
        etf = Math.max(0, (etf + monthlyContribution) * (1 + r));
        contributed += monthlyContribution;
      }
      const gain = Math.max(0, etf - contributed);
      etfByYear.push(etf - gain * exitTaxRate(wrapper, y.year));
    }

    const realEstateNetWorth = rental.final.netEquityIfSold * units;
    // La trésorerie cumulée est déjà réinjectée côté ETF : on compare donc le seul patrimoine immobilier net de dette.
    const cumulatedCash = rental.years.reduce((acc, y) => acc + y.cashFlow, 0) * units;
    const reNet = realEstateNetWorth - cumulatedCash;
    const etfNet = etfByYear[etfByYear.length - 1]!;
    const difference = reNet - etfNet;
    const tolerance = Math.max(reNet, etfNet) * 0.05;

    scenarios.push({
      scenario,
      realEstateNetWorth: round2(reNet),
      etfNetWorth: round2(etfNet),
      difference: round2(difference),
      winner: Math.abs(difference) <= tolerance ? "equivalent" : difference > 0 ? "immobilier" : "etf",
    });

    if (scenario === "central") {
      rentalCentral = rental;
      let cash = 0;
      series = rental.years.map((y, i) => {
        cash += y.cashFlow;
        return { year: y.year, immobilier: round2((y.netEquityIfSold - cash) * units), etf: round2(etfByYear[i]!) };
      });
    }
  }

  const central = rentalCentral!;
  const notes = [
    "Comparaison à effort d'épargne identique : même apport, mêmes versements annuels.",
    "L'immobilier utilise l'effet de levier du crédit : il amplifie les gains comme les pertes et ajoute une dette.",
    "Non pris en compte : temps de gestion, impayés prolongés, gros travaux imprévus, difficulté à revendre rapidement.",
    ...central.warnings,
  ];
  if (wrapper === "PEA") notes.push("Le PEA est plafonné à 150 000 € de versements ; au-delà, la fiscalité du compte-titres s'applique.");

  return {
    units,
    years,
    downPayment: round2(central.cashInvested * units),
    averageMonthlyEffort: round2(central.averageMonthlyEffort * units),
    totalDebt: round2(central.loanPrincipal * units),
    scenarios,
    series,
    rentalCentral: central,
    notes,
  };
}
