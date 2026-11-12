/** Utilitaires numériques partagés par tout le moteur. Aucune dépendance, aucun effet de bord. */

export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
export const round0 = (n: number): number => Math.round(n);

export const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);

/** Taux mensuel équivalent à un taux annuel composé. */
export const monthlyRate = (annual: number): number => Math.pow(1 + annual, 1 / 12) - 1;

export const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));

const eurFormatter = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const eurCentsFormatter = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pctFormatter = new Intl.NumberFormat("fr-FR", { style: "percent", maximumFractionDigits: 1 });
const pctFineFormatter = new Intl.NumberFormat("fr-FR", { style: "percent", maximumFractionDigits: 2 });

/** Les espaces insécables de Intl sont normalisés pour un rendu identique partout. */
const tidy = (s: string): string => s.replace(/[  ]/g, " ");

export const eur = (n: number): string => tidy(eurFormatter.format(n));
export const eurCents = (n: number): string => tidy(eurCentsFormatter.format(n));
/** Une décimale, deux pour les petits taux (frais de 0,25 %). */
export const pct = (n: number): string => tidy((Math.abs(n) < 0.01 ? pctFineFormatter : pctFormatter).format(n));

export function assertFinitePositive(name: string, value: number, allowZero = true): void {
  if (!Number.isFinite(value) || value < 0 || (!allowZero && value === 0)) {
    throw new RangeError(`Paramètre invalide « ${name} » : ${value}`);
  }
}
