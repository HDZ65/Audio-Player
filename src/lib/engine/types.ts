/** Types de données financières manipulés par le moteur (indépendants du stockage). */

export type AccountKind = "courant" | "livret" | "pea" | "cto" | "assurance_vie" | "credit" | "immobilier" | "autre";

export interface AccountLike {
  id: number;
  name: string;
  institution: string | null;
  kind: AccountKind;
  balance: number;
  /** Date de la photographie du solde (AAAA-MM-JJ). */
  asOf: string;
}

export type AssetClass = "action" | "etf" | "obligation" | "fonds" | "crypto" | "autre";

export interface HoldingLike {
  id: number;
  accountId: number | null;
  name: string;
  ticker: string | null;
  assetClass: AssetClass;
  sector: string | null;
  /** Valeur de la ligne ; null si inconnue (on n'invente jamais un cours). */
  value: number | null;
  asOf: string | null;
}

export const LIQUID_KINDS: readonly AccountKind[] = ["courant", "livret"];
export const INVESTMENT_KINDS: readonly AccountKind[] = ["pea", "cto", "assurance_vie"];
