import type { Situation } from "@/lib/db/seed";

/** Situation fictive servant de base aux tests. */
export const SITUATION: Situation = {
  asOf: new Date().toISOString().slice(0, 10),
  source: "test",
  profile: { salaireNetMensuel: 2700, loyerMensuel: 700, autresDepensesMensuelles: null, objectifPrioritaire: "Développer mon patrimoine" },
  accounts: [
    { name: "Compte courant", institution: "Banque", kind: "courant", balance: 2000 },
    { name: "LEP", institution: "Banque", kind: "livret", balance: 800 },
    { name: "PEA", institution: "Banque", kind: "pea", balance: 300 },
    { name: "Compte-titres", institution: "Banque", kind: "cto", balance: 150 },
    { name: "Autre compte-titres", kind: "cto", balance: 4000 },
  ],
  holdings: [
    { name: "Apple", assetClass: "action", sector: "Technologie" },
    { name: "Micron Technology", assetClass: "action", sector: "Semi-conducteurs" },
    { name: "Advantest", assetClass: "action", sector: "Semi-conducteurs" },
    { name: "Alphabet", assetClass: "action", sector: "Technologie" },
    { name: "ETF S&P 500", assetClass: "etf" },
  ],
};
