import { round2 } from "./money";
import { simulateLoan } from "./loan";
import { CREDIT, TAX } from "./params";

export type RentalRegime = "micro_foncier" | "reel" | "lmnp_micro_bic";

export interface RentalInput {
  price: number;
  /** Frais d'acquisition (notaire), en part du prix. Ancien : ~8 %. */
  notaryRate?: number;
  works?: number;
  furniture?: number;
  downPayment: number;
  annualRate?: number;
  loanYears?: number;
  insuranceRate?: number;
  monthlyRent: number;
  /** Mois de vacance locative par an. */
  vacancyMonthsPerYear?: number;
  /** Charges de copropriété non récupérables, par an. */
  annualCharges?: number;
  propertyTax?: number;
  /** Assurance propriétaire non occupant, par an. */
  landlordInsurance?: number;
  /** Frais de gestion locative, en part des loyers encaissés. */
  managementRate?: number;
  /** Provision d'entretien et d'imprévus, en part des loyers encaissés. */
  maintenanceRate?: number;
  rentGrowth?: number;
  priceGrowth?: number;
  regime?: RentalRegime;
  /** Tranche marginale d'imposition de l'investisseur. */
  marginalTaxRate: number;
  years: number;
  /** Frais de revente (agence, diagnostics), en part du prix de vente. */
  saleCostRate?: number;
}

export interface RentalYear {
  year: number;
  rent: number;
  operatingCosts: number;
  loanPayments: number;
  interest: number;
  tax: number;
  /** Trésorerie nette de l'année (négative = effort d'épargne). */
  cashFlow: number;
  propertyValue: number;
  remainingLoan: number;
  /** Patrimoine net si le bien était revendu cette année (après frais et impôt sur la plus-value). */
  netEquityIfSold: number;
}

export interface RentalResult {
  totalCost: number;
  loanPrincipal: number;
  monthlyLoanPayment: number;
  grossYield: number;
  netYield: number;
  /** Effort d'épargne mensuel moyen sur la période (positif = il faut remettre de l'argent). */
  averageMonthlyEffort: number;
  firstYearMonthlyCashFlow: number;
  cashInvested: number;
  years: RentalYear[];
  final: RentalYear;
  /** Gain net : patrimoine final + trésorerie cumulée − apport. */
  netGain: number;
  regime: RentalRegime;
  warnings: string[];
}

/** Abattements pour durée de détention sur la plus-value immobilière (CGI art. 150 VC). */
export function propertyGainAllowances(yearsHeld: number): { ir: number; ps: number } {
  const y = Math.floor(yearsHeld);
  let ir = 0;
  let ps = 0;
  for (let i = 6; i <= y; i++) {
    if (i <= 21) {
      ir += 0.06;
      ps += 0.0165;
    } else if (i === 22) {
      ir += 0.04;
      ps += 0.016;
    } else if (i <= 30) {
      ps += 0.09;
    }
  }
  return { ir: Math.min(1, ir), ps: Math.min(1, ps) };
}

export function propertyGainTax(salePrice: number, purchasePrice: number, yearsHeld: number): number {
  // Forfaits légaux : 7,5 % de frais d'acquisition, 15 % de travaux après 5 ans de détention.
  const adjustedPurchase = purchasePrice * (1 + 0.075 + (yearsHeld > 5 ? 0.15 : 0));
  const gain = salePrice - adjustedPurchase;
  if (gain <= 0) return 0;
  const { ir, ps } = propertyGainAllowances(yearsHeld);
  return gain * (1 - ir) * TAX.propertyGainIR.value + gain * (1 - ps) * TAX.psFoncier.value;
}

/**
 * Simulation d'un investissement locatif, année par année.
 * Simplifications assumées et signalées : pas d'amortissement comptable (LMNP réel non modélisé),
 * déficit foncier simplement reporté, surtaxe sur les fortes plus-values ignorée.
 */
export function simulateRental(input: RentalInput): RentalResult {
  const notaryRate = input.notaryRate ?? 0.08;
  const works = input.works ?? 0;
  const furniture = input.furniture ?? 0;
  const annualRate = input.annualRate ?? CREDIT.indicativeRate.value;
  const loanYears = input.loanYears ?? 25;
  const insuranceRate = input.insuranceRate ?? CREDIT.insuranceRate.value;
  const vacancy = input.vacancyMonthsPerYear ?? 1;
  const annualCharges = input.annualCharges ?? input.price * 0.008;
  const propertyTax = input.propertyTax ?? input.monthlyRent * 1.2;
  const landlordInsurance = input.landlordInsurance ?? 150;
  const managementRate = input.managementRate ?? 0;
  const maintenanceRate = input.maintenanceRate ?? 0.05;
  const rentGrowth = input.rentGrowth ?? 0.015;
  const priceGrowth = input.priceGrowth ?? 0.01;
  const regime = input.regime ?? "micro_foncier";
  const saleCostRate = input.saleCostRate ?? 0.05;
  const warnings: string[] = [];

  if (input.years < 1 || input.years > 40) throw new RangeError("Durée de simulation : entre 1 et 40 ans");
  const totalCost = input.price * (1 + notaryRate) + works + furniture;
  if (input.downPayment > totalCost) throw new RangeError("L'apport dépasse le coût total de l'opération");
  const loanPrincipal = totalCost - input.downPayment;
  const loan = simulateLoan({ principal: loanPrincipal, annualRate, years: loanYears, insuranceRate });

  const annualRentFull = input.monthlyRent * 12;
  if (regime === "micro_foncier" && annualRentFull > TAX.microFoncierCeiling.value) {
    warnings.push("Loyers supérieurs au plafond du micro-foncier : le régime réel s'appliquerait.");
  }
  if (input.downPayment < input.price * notaryRate) {
    warnings.push("Apport inférieur aux frais d'acquisition : les banques financent rarement les frais de notaire.");
  }

  const years: RentalYear[] = [];
  let cumulatedCash = 0;
  let carriedDeficit = 0;

  for (let y = 1; y <= input.years; y++) {
    const growthFactor = Math.pow(1 + rentGrowth, y - 1);
    const rent = input.monthlyRent * (12 - vacancy) * growthFactor;
    const operatingCosts = annualCharges * growthFactor + propertyTax * growthFactor + landlordInsurance + rent * (managementRate + maintenanceRate);
    const loanYear = loan.schedule[y - 1];
    const interest = loanYear?.interest ?? 0;
    const insurance = loanYear?.insurance ?? 0;
    const loanPayments = loanYear ? loanYear.interest + loanYear.principalRepaid + loanYear.insurance : 0;

    let taxable: number;
    let socialRate: number = TAX.psFoncier.value;
    if (regime === "micro_foncier") {
      taxable = rent * (1 - TAX.microFoncierAllowance.value);
    } else if (regime === "lmnp_micro_bic") {
      taxable = rent * (1 - TAX.microBicAllowance.value);
    } else {
      const result = rent - operatingCosts - interest - insurance - carriedDeficit;
      carriedDeficit = result < 0 ? -result : 0;
      taxable = Math.max(0, result);
    }
    if (regime === "lmnp_micro_bic") socialRate = TAX.psFoncier.value;
    const tax = taxable * (input.marginalTaxRate + socialRate);

    const cashFlow = rent - operatingCosts - loanPayments - tax;
    cumulatedCash += cashFlow;

    const propertyValue = (input.price + works) * Math.pow(1 + priceGrowth, y);
    const remainingLoan = loanYear ? loanYear.remaining : 0;
    const saleNet = propertyValue * (1 - saleCostRate) - propertyGainTax(propertyValue * (1 - saleCostRate), input.price, y);
    years.push({
      year: y,
      rent: round2(rent),
      operatingCosts: round2(operatingCosts),
      loanPayments: round2(loanPayments),
      interest: round2(interest),
      tax: round2(tax),
      cashFlow: round2(cashFlow),
      propertyValue: round2(propertyValue),
      remainingLoan: round2(remainingLoan),
      netEquityIfSold: round2(saleNet - remainingLoan + cumulatedCash),
    });
  }

  const first = years[0]!;
  const final = years[years.length - 1]!;
  const netYield = (first.rent - first.operatingCosts) / totalCost;
  if (first.cashFlow < 0) warnings.push("Trésorerie négative dès la première année : un effort d'épargne mensuel est nécessaire.");

  return {
    totalCost: round2(totalCost),
    loanPrincipal: round2(loanPrincipal),
    monthlyLoanPayment: loan.monthlyTotal,
    grossYield: round2((annualRentFull / totalCost) * 10000) / 10000,
    netYield: round2(netYield * 10000) / 10000,
    averageMonthlyEffort: round2(-cumulatedCash / (input.years * 12)),
    firstYearMonthlyCashFlow: round2(first.cashFlow / 12),
    cashInvested: round2(input.downPayment),
    years,
    final,
    netGain: round2(final.netEquityIfSold - input.downPayment),
    regime,
    warnings,
  };
}
