import { assertFinitePositive, round2 } from "./money";
import { CREDIT } from "./params";

export interface LoanInput {
  principal: number;
  annualRate: number;
  years: number;
  /** Assurance emprunteur, en taux annuel appliqué au capital initial. */
  insuranceRate?: number;
}

export interface LoanYear {
  year: number;
  interest: number;
  principalRepaid: number;
  insurance: number;
  remaining: number;
}

export interface LoanResult {
  monthlyPayment: number;
  monthlyInsurance: number;
  monthlyTotal: number;
  totalInterest: number;
  totalInsurance: number;
  totalCost: number;
  schedule: LoanYear[];
}

/** Mensualité hors assurance d'un prêt amortissable à taux fixe. */
export function monthlyPayment(principal: number, annualRate: number, years: number): number {
  assertFinitePositive("capital", principal);
  assertFinitePositive("taux", annualRate);
  assertFinitePositive("durée", years, false);
  const n = Math.round(years * 12);
  const r = annualRate / 12;
  if (principal === 0) return 0;
  if (r === 0) return principal / n;
  return (principal * r) / (1 - Math.pow(1 + r, -n));
}

export function simulateLoan(input: LoanInput): LoanResult {
  const { principal, annualRate, years } = input;
  const insuranceRate = input.insuranceRate ?? 0;
  const payment = monthlyPayment(principal, annualRate, years);
  const monthlyInsurance = (principal * insuranceRate) / 12;
  const n = Math.round(years * 12);
  const r = annualRate / 12;

  const schedule: LoanYear[] = [];
  let remaining = principal;
  let totalInterest = 0;
  let yearInterest = 0;
  let yearPrincipal = 0;

  for (let m = 1; m <= n; m++) {
    const interest = remaining * r;
    const repaid = m === n ? remaining : payment - interest;
    remaining = Math.max(0, remaining - repaid);
    totalInterest += interest;
    yearInterest += interest;
    yearPrincipal += repaid;
    if (m % 12 === 0 || m === n) {
      schedule.push({
        year: Math.ceil(m / 12),
        interest: round2(yearInterest),
        principalRepaid: round2(yearPrincipal),
        insurance: round2(monthlyInsurance * (m % 12 === 0 ? 12 : m % 12)),
        remaining: round2(remaining),
      });
      yearInterest = 0;
      yearPrincipal = 0;
    }
  }

  const totalInsurance = monthlyInsurance * n;
  return {
    monthlyPayment: round2(payment),
    monthlyInsurance: round2(monthlyInsurance),
    monthlyTotal: round2(payment + monthlyInsurance),
    totalInterest: round2(totalInterest),
    totalInsurance: round2(totalInsurance),
    totalCost: round2(totalInterest + totalInsurance),
    schedule,
  };
}

export interface BorrowingCapacityInput {
  netMonthlyIncome: number;
  /** Charges retenues par la banque : loyer si l'on reste locataire, autres crédits. */
  existingMonthlyCharges: number;
  /** Loyers attendus du bien financé (pondérés par la banque). */
  expectedMonthlyRent?: number;
  annualRate?: number;
  years?: number;
  insuranceRate?: number;
}

export interface BorrowingCapacity {
  maxMonthlyPayment: number;
  maxPrincipal: number;
  debtRatioUsed: number;
  consideredIncome: number;
  assumptions: { annualRate: number; years: number; insuranceRate: number; rentalIncomeWeight: number };
}

/**
 * Capacité d'emprunt selon la règle HCSF (35 % des revenus, assurance incluse).
 * Les loyers futurs sont ajoutés aux revenus après pondération.
 */
export function borrowingCapacity(input: BorrowingCapacityInput): BorrowingCapacity {
  const annualRate = input.annualRate ?? CREDIT.indicativeRate.value;
  const years = input.years ?? 25;
  const insuranceRate = input.insuranceRate ?? CREDIT.insuranceRate.value;
  const weight = CREDIT.rentalIncomeWeight.value;
  const consideredIncome = input.netMonthlyIncome + (input.expectedMonthlyRent ?? 0) * weight;
  const maxMonthlyPayment = Math.max(0, consideredIncome * CREDIT.maxDebtRatio.value - input.existingMonthlyCharges);

  // Mensualité (assurance comprise) pour 1 € emprunté.
  const perEuro = monthlyPayment(1, annualRate, years) + insuranceRate / 12;
  const maxPrincipal = perEuro > 0 ? maxMonthlyPayment / perEuro : 0;

  return {
    maxMonthlyPayment: round2(maxMonthlyPayment),
    maxPrincipal: Math.floor(maxPrincipal / 100) * 100,
    debtRatioUsed: CREDIT.maxDebtRatio.value,
    consideredIncome: round2(consideredIncome),
    assumptions: { annualRate, years, insuranceRate, rentalIncomeWeight: weight },
  };
}
