import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { DB } from "./client";
import { PROFILE_KEYS, audit, createAccount, createGoal, createHolding, isEmpty, listAccounts, upsertFact } from "./repo";

const kind = z.enum(["courant", "livret", "pea", "cto", "assurance_vie", "credit", "immobilier", "autre"]);
const assetClass = z.enum(["action", "etf", "obligation", "fonds", "crypto", "autre"]);

export const situationSchema = z.object({
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  source: z.string().default("déclaration initiale"),
  profile: z
    .object({
      salaireNetMensuel: z.number().nonnegative().optional(),
      loyerMensuel: z.number().nonnegative().optional(),
      autresDepensesMensuelles: z.number().nonnegative().nullable().optional(),
      toleranceRisque: z.string().optional(),
      horizonAnnees: z.number().positive().optional(),
      partsFiscales: z.number().positive().optional(),
      projetResidencePrincipale: z.string().optional(),
      objectifPrioritaire: z.string().optional(),
    })
    .default({}),
  accounts: z.array(z.object({ name: z.string().min(1), institution: z.string().nullable().optional(), kind, balance: z.number(), notes: z.string().optional() })).default([]),
  holdings: z.array(z.object({ name: z.string().min(1), account: z.string().optional(), ticker: z.string().optional(), assetClass: assetClass.default("action"), sector: z.string().optional(), value: z.number().nonnegative().nullable().optional() })).default([]),
  goals: z.array(z.object({ title: z.string(), targetAmount: z.number().positive(), monthlyContribution: z.number().nonnegative().optional() })).default([]),
});
export type Situation = z.input<typeof situationSchema>;

/** Importe une situation de départ. Les informations absentes sont enregistrées comme « manquantes », jamais devinées. */
export function importSituation(db: DB, raw: unknown): { accounts: number; holdings: number } {
  const s = situationSchema.parse(raw);
  const base = { source: s.source, asOf: s.asOf };
  db.transaction(() => {
    const num = (def: { key: string; category: string; label: string }, value: number | null | undefined) => {
      if (value === undefined) return;
      upsertFact(db, { ...def, ...base, value: value === null ? null : String(value), numericValue: value, status: value === null ? "manquant" : "verifie" }, "systeme");
    };
    const text = (def: { key: string; category: string; label: string }, value: string | undefined) => {
      if (value !== undefined) upsertFact(db, { ...def, ...base, value, status: "verifie" }, "systeme");
    };
    num(PROFILE_KEYS.salary, s.profile.salaireNetMensuel);
    num(PROFILE_KEYS.rent, s.profile.loyerMensuel);
    num(PROFILE_KEYS.otherExpenses, s.profile.autresDepensesMensuelles === undefined ? null : s.profile.autresDepensesMensuelles);
    num(PROFILE_KEYS.horizon, s.profile.horizonAnnees);
    num(PROFILE_KEYS.taxParts, s.profile.partsFiscales);
    text(PROFILE_KEYS.riskTolerance, s.profile.toleranceRisque);
    text(PROFILE_KEYS.mainHome, s.profile.projetResidencePrincipale);
    text(PROFILE_KEYS.priority, s.profile.objectifPrioritaire);

    for (const a of s.accounts) createAccount(db, { ...a, asOf: s.asOf, source: s.source }, "systeme");
    const accounts = listAccounts(db);
    for (const h of s.holdings) {
      const account = h.account ? accounts.find((a) => a.name === h.account) : undefined;
      createHolding(db, { name: h.name, accountId: account?.id ?? null, ticker: h.ticker, assetClass: h.assetClass, sector: h.sector, value: h.value ?? null, asOf: s.asOf, source: s.source });
    }
    for (const g of s.goals) createGoal(db, g, "systeme");
    audit(db, "systeme", "import.situation", `${s.accounts.length} compte(s), ${s.holdings.length} ligne(s), photographie du ${s.asOf}`);
  })();
  return { accounts: s.accounts.length, holdings: s.holdings.length };
}

/** Au premier démarrage, charge seed/situation.local.json s'il existe (fichier personnel, non versionné). */
export function ensureSeeded(db: DB): void {
  if (!isEmpty(db)) return;
  const file = path.resolve(process.cwd(), "seed/situation.local.json");
  if (!fs.existsSync(file)) return;
  importSituation(db, JSON.parse(fs.readFileSync(file, "utf8")));
}
