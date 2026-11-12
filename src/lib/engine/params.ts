/**
 * Hypothèses réglementaires et de marché utilisées par le moteur.
 *
 * Règle de transparence : chaque paramètre porte une date, une source et un statut.
 *  - "fait"       : valeur réglementaire publiée, vérifiée à la date indiquée ;
 *  - "a_verifier" : valeur plausible mais dont les sources divergent ou qui dépend de la situation ;
 *  - "hypothese"  : convention de simulation, jamais une prévision ni une garantie.
 *
 * Ces valeurs sont centralisées ici pour qu'un changement fiscal se traduise par
 * une seule modification, tracée, et par la réévaluation des plans qui en dépendent.
 */

export type ParamStatus = "fait" | "a_verifier" | "hypothese";

export interface Param<T = number> {
  value: T;
  label: string;
  status: ParamStatus;
  asOf: string;
  source: string;
}

const p = <T,>(value: T, label: string, status: ParamStatus, asOf: string, source: string): Param<T> => ({ value, label, status, asOf, source });

export const PARAMS_AS_OF = "2026-11-12";

export const TAX = {
  pfuIR: p(0.128, "Part impôt sur le revenu du PFU", "fait", "2026-01-01", "CGI art. 200 A"),
  psCapital: p(0.186, "Prélèvements sociaux sur revenus du capital mobilier (compte-titres, PEA)", "fait", "2026-01-01", "LFSS 2026 — CSG portée de 9,2 % à 10,6 %"),
  psFoncier: p(0.172, "Prélèvements sociaux sur revenus fonciers et plus-values immobilières", "a_verifier", "2026-01-01", "LFSS 2026 — périmètre des exclusions à confirmer (sources divergentes)"),
  peaExemptionYears: p(5, "Ancienneté du PEA pour l'exonération d'impôt sur le revenu", "fait", "2026-01-01", "CGI art. 157, 5° bis"),
  peaCeiling: p(150_000, "Plafond de versements du PEA", "fait", "2026-01-01", "Code monétaire et financier L221-30"),
  microFoncierAllowance: p(0.3, "Abattement micro-foncier", "fait", "2026-01-01", "CGI art. 32"),
  microFoncierCeiling: p(15_000, "Plafond de loyers du micro-foncier", "fait", "2026-01-01", "CGI art. 32"),
  microBicAllowance: p(0.5, "Abattement micro-BIC (location meublée longue durée)", "a_verifier", "2026-01-01", "CGI art. 50-0 — régime modifié plusieurs fois depuis 2024"),
  microBicCeiling: p(77_700, "Plafond de recettes micro-BIC (meublé longue durée)", "a_verifier", "2026-01-01", "CGI art. 50-0"),
  propertyGainIR: p(0.19, "Impôt sur la plus-value immobilière", "fait", "2026-01-01", "CGI art. 200 B"),
  /** Barème de l'impôt sur le revenu (revenus 2025, imposition 2026), pour une part. */
  incomeBrackets: p(
    [
      { upTo: 11_600, rate: 0 },
      { upTo: 29_579, rate: 0.11 },
      { upTo: 84_577, rate: 0.3 },
      { upTo: 181_917, rate: 0.41 },
      { upTo: Infinity, rate: 0.45 },
    ],
    "Barème de l'impôt sur le revenu par part",
    "a_verifier",
    "2026-01-01",
    "Loi de finances 2026 — à confirmer sur impots.gouv.fr",
  ),
  salaryAllowance: p(0.1, "Abattement forfaitaire pour frais professionnels", "fait", "2026-01-01", "CGI art. 83"),
} as const;

export const SAVINGS = {
  livretA: p(0.017, "Taux du Livret A", "fait", "2026-08-01", "Arrêté du 1er août 2026"),
  lep: p(0.025, "Taux du LEP", "fait", "2026-08-01", "Maintenu du 1er août 2026 au 31 janvier 2027"),
  lepCeiling: p(10_000, "Plafond de dépôt du LEP", "fait", "2026-01-01", "Code monétaire et financier"),
  livretACeiling: p(22_950, "Plafond de dépôt du Livret A", "fait", "2026-01-01", "Code monétaire et financier"),
} as const;

export const CREDIT = {
  maxDebtRatio: p(0.35, "Taux d'endettement maximal (assurance incluse)", "fait", "2026-01-01", "HCSF — décision D-HCSF-2021-7"),
  maxYears: p(25, "Durée maximale d'un crédit immobilier", "fait", "2026-01-01", "HCSF"),
  rentalIncomeWeight: p(0.7, "Part des loyers retenue par les banques", "hypothese", PARAMS_AS_OF, "Pratique bancaire courante, variable selon l'établissement"),
  indicativeRate: p(0.034, "Taux indicatif d'un crédit immobilier sur 20-25 ans", "hypothese", PARAMS_AS_OF, "Ordre de grandeur à remplacer par une offre réelle"),
  insuranceRate: p(0.003, "Taux indicatif de l'assurance emprunteur (capital initial)", "hypothese", PARAMS_AS_OF, "Ordre de grandeur à remplacer par un devis"),
} as const;

/**
 * Scénarios de marché pour un ETF actions mondiales diversifié.
 * Ce ne sont PAS des prévisions : ce sont des conventions de simulation,
 * à lire ensemble (fourchette), jamais isolément.
 */
export const MARKET = {
  scenarios: p(
    { prudent: 0.03, central: 0.06, favorable: 0.08 },
    "Rendements annuels nominaux simulés (actions mondiales, avant frais)",
    "hypothese",
    PARAMS_AS_OF,
    "Convention de simulation — les performances passées ne préjugent pas des performances futures",
  ),
  volatility: p(0.16, "Volatilité annuelle simulée (actions mondiales)", "hypothese", PARAMS_AS_OF, "Ordre de grandeur historique de long terme"),
  etfFees: p(0.0025, "Frais annuels d'un ETF large indice", "hypothese", PARAMS_AS_OF, "À remplacer par les frais réels du support"),
  inflation: p(0.02, "Inflation annuelle simulée", "hypothese", PARAMS_AS_OF, "Cible de la BCE"),
} as const;

export const SAFETY = {
  emergencyMonthsMin: p(3, "Épargne de précaution minimale (mois de dépenses)", "hypothese", PARAMS_AS_OF, "Règle prudentielle usuelle"),
  emergencyMonthsComfort: p(6, "Épargne de précaution confortable (mois de dépenses)", "hypothese", PARAMS_AS_OF, "Règle prudentielle usuelle"),
  concentrationWarn: p(0.2, "Seuil d'alerte de concentration sur une seule ligne", "hypothese", PARAMS_AS_OF, "Règle prudentielle interne"),
  unemploymentReplacement: p(0.7, "Allocation chômage estimée, en part du salaire net", "hypothese", PARAMS_AS_OF, "Approximation — le montant réel dépend du salaire brut de référence (France Travail)"),
} as const;

export type ScenarioName = "prudent" | "central" | "favorable";
export const SCENARIO_NAMES: readonly ScenarioName[] = ["prudent", "central", "favorable"];
export const SCENARIO_LABELS: Record<ScenarioName, string> = { prudent: "Prudent", central: "Central", favorable: "Favorable" };

/** Impôt sur le revenu et tranche marginale estimés à partir d'un salaire net annuel (une part). */
export function estimateIncomeTax(netAnnualSalary: number, parts = 1): { taxable: number; tax: number; marginalRate: number } {
  const taxable = Math.max(0, netAnnualSalary * (1 - TAX.salaryAllowance.value));
  const perPart = taxable / parts;
  let tax = 0;
  let previous = 0;
  let marginalRate = 0;
  for (const bracket of TAX.incomeBrackets.value) {
    if (perPart > previous) {
      tax += (Math.min(perPart, bracket.upTo) - previous) * bracket.rate;
      marginalRate = bracket.rate;
    }
    previous = bracket.upTo;
  }
  return { taxable: Math.round(taxable), tax: Math.round(tax * parts), marginalRate };
}
