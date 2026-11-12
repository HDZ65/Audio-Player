"use client";

import { useState } from "react";
import { Page, Section } from "@/components/AppShell";
import { BarList } from "@/components/charts/BarList";
import { toNumber, useAction, useData } from "@/components/useData";
import { api, frDate } from "@/lib/client";
import { eur, eurCents, pct } from "@/lib/engine/money";

interface Tx { id: number; date: string; label: string; amount: number; category: string }
interface TxData { transactions: Tx[]; categories: string[]; observed: { months: number; averageMonthly: number; averageMonthlyExcludingHousing: number; byCategory: { category: string; averageMonthly: number }[]; from: string; to: string } | null }
interface Overview { budget: { income: number | null; knownExpenses: number; totalExpenses: number | null; savingsCapacity: number | null; savingsCapacityUpperBound: number | null; savingsRate: number | null }; emergency: { monthsCovered: number; level: string; targetMin: number; gapToMin: number; expensesAreLowerBound: boolean } | null }
interface FactsData { facts: { key: string; numericValue: number | null; status: string }[] }
interface Account { id: number; name: string; kind: string }

const FIELDS = [
  { key: "revenu.salaire_net_mensuel", category: "revenu", label: "Salaire net mensuel" },
  { key: "charge.loyer", category: "charge", label: "Loyer mensuel" },
  { key: "charge.autres_depenses", category: "charge", label: "Autres dépenses mensuelles (hors loyer)" },
];

export default function BudgetPage() {
  const tx = useData<TxData>("/api/data/transactions");
  const overview = useData<Overview>("/api/overview");
  const facts = useData<FactsData>("/api/data/facts");
  const accounts = useData<Account[]>("/api/data/accounts");
  const { run, error, busy } = useAction();
  const [importResult, setImportResult] = useState<string | null>(null);
  const [accountId, setAccountId] = useState("");
  const [draft, setDraft] = useState<Record<string, string>>({});

  const reload = () => { void tx.reload(); void overview.reload(); void facts.reload(); };
  const factValue = (key: string) => facts.data?.facts.find((f) => f.key === key);

  const saveFact = async (field: (typeof FIELDS)[number], status: "verifie" | "estime") => {
    const value = toNumber(draft[field.key] ?? "");
    if (value === null || value < 0) return;
    if (await run(() => api("/api/data/facts", { method: "POST", body: { ...field, value: String(value), numericValue: value, status } }))) {
      setDraft((d) => ({ ...d, [field.key]: "" }));
      reload();
    }
  };

  const importCsv = async (file: File | undefined) => {
    if (!file) return;
    setImportResult(null);
    const text = await file.text();
    await run(async () => {
      const r = await api<{ inserted: number; duplicates: number; skipped: number }>("/api/import", { method: "POST", body: { type: "csv", text, accountId: accountId ? Number(accountId) : null } });
      setImportResult(`${r.inserted} opération(s) importée(s), ${r.duplicates} doublon(s) ignoré(s), ${r.skipped} ligne(s) illisible(s).`);
      reload();
    });
  };

  const b = overview.data?.budget;
  const e = overview.data?.emergency;
  const o = tx.data?.observed;

  return (
    <Page title="Budget" subtitle="Tes revenus, tes charges et tes opérations. C'est ce qui détermine ta capacité d'épargne, donc tout le reste.">
      {error && <p className="mb-4 rounded-lg bg-critical-soft px-3 py-2 text-sm text-critical">{error}</p>}

      {b && (
        <dl className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="card px-4 py-3"><dt className="text-xs text-ink-3">Revenu net</dt><dd className="tabular mt-1 text-xl font-semibold">{b.income !== null ? eur(b.income) : "—"}</dd></div>
          <div className="card px-4 py-3"><dt className="text-xs text-ink-3">Dépenses</dt><dd className="tabular mt-1 text-xl font-semibold">{b.totalExpenses !== null ? eur(b.totalExpenses) : `≥ ${eur(b.knownExpenses)}`}</dd>{b.totalExpenses === null && <dd className="text-xs text-ink-3">incomplet</dd>}</div>
          <div className="card px-4 py-3"><dt className="text-xs text-ink-3">Capacité d'épargne</dt><dd className="tabular mt-1 text-xl font-semibold">{b.savingsCapacity !== null ? eur(b.savingsCapacity) : "inconnue"}</dd><dd className="text-xs text-ink-3">{b.savingsRate !== null ? `${pct(b.savingsRate)} du revenu` : b.savingsCapacityUpperBound !== null ? `au plus ${eur(b.savingsCapacityUpperBound)}` : ""}</dd></div>
          <div className="card px-4 py-3"><dt className="text-xs text-ink-3">Épargne de précaution</dt><dd className="tabular mt-1 text-xl font-semibold">{e ? `${e.monthsCovered.toFixed(1).replace(".", ",")} mois` : "—"}</dd><dd className="text-xs text-ink-3">{e ? (e.expensesAreLowerBound ? "de loyer seul" : `niveau ${e.level}`) : "dépenses à renseigner"}</dd></div>
        </dl>
      )}

      <Section title="Revenus et charges" hint="Indique « estimation » si tu donnes un ordre de grandeur : l'assistant en tiendra compte dans ses conclusions.">
        <div className="space-y-3">
          {FIELDS.map((field) => {
            const fact = factValue(field.key);
            const known = fact && fact.status !== "manquant" && fact.numericValue !== null;
            return (
              <div key={field.key} className="grid items-end gap-2 sm:grid-cols-[1fr_auto]">
                <label><span className="label">{field.label} — actuellement : <span className="text-ink">{known ? `${eur(fact.numericValue!)}${fact.status === "estime" ? " (estimation)" : ""}` : "non renseigné"}</span></span>
                  <input inputMode="decimal" className="field tabular" placeholder="Nouvelle valeur en €" value={draft[field.key] ?? ""} onChange={(ev) => setDraft({ ...draft, [field.key]: ev.target.value })} /></label>
                <div className="flex gap-2"><button className="btn btn-primary" disabled={busy || !(draft[field.key] ?? "").trim()} onClick={() => saveFact(field, "verifie")}>Enregistrer</button><button className="btn btn-ghost" disabled={busy || !(draft[field.key] ?? "").trim()} onClick={() => saveFact(field, "estime")}>Estimation</button></div>
              </div>
            );
          })}
        </div>
      </Section>

      <Section title="Importer un relevé" hint="Fichier CSV exporté depuis ta banque (date, libellé, montant). Les doublons sont ignorés et les opérations classées automatiquement ; le fichier reste sur cette machine.">
        <div className="flex flex-wrap items-end gap-3">
          <label><span className="label">Compte concerné</span><select className="field" value={accountId} onChange={(ev) => setAccountId(ev.target.value)}><option value="">Non précisé</option>{(accounts.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
          <label className="btn btn-ghost cursor-pointer">Choisir un fichier CSV<input type="file" accept=".csv,text/csv" className="sr-only" onChange={(ev) => { void importCsv(ev.target.files?.[0]); ev.target.value = ""; }} /></label>
        </div>
        {importResult && <p className="mt-3 text-sm text-ink-2">{importResult}</p>}
      </Section>

      {o && (
        <Section title="Dépenses moyennes par mois" hint={`Observées sur ${o.months} mois complet(s), de ${o.from} à ${o.to}. Total : ${eur(o.averageMonthly)} par mois, dont ${eur(o.averageMonthlyExcludingHousing)} hors logement.`}>
          <BarList unit="€" items={o.byCategory.map((c) => ({ label: c.category, value: c.averageMonthly }))} />
        </Section>
      )}

      <Section title="Opérations" hint={tx.data ? `${tx.data.transactions.length} opération(s) affichée(s). Corrige une catégorie si le classement automatique s'est trompé.` : undefined}>
        <div className="max-h-[480px] overflow-auto">
          <table className="w-full min-w-[520px] text-sm">
            <thead className="sticky top-0 bg-surface"><tr className="border-b border-line text-left text-xs text-ink-3"><th className="py-2 font-medium">Date</th><th className="font-medium">Libellé</th><th className="font-medium">Catégorie</th><th className="text-right font-medium">Montant</th><th /></tr></thead>
            <tbody>
              {(tx.data?.transactions ?? []).map((t) => (
                <tr key={t.id} className="border-b border-line/60">
                  <td className="whitespace-nowrap py-2 text-ink-2">{frDate(t.date)}</td>
                  <td className="max-w-[240px] truncate" title={t.label}>{t.label}</td>
                  <td><select aria-label={`Catégorie de ${t.label}`} className="field !w-auto !py-1 text-xs" value={t.category} onChange={async (ev) => { if (await run(() => api(`/api/data/transactions?id=${t.id}`, { method: "PATCH", body: { category: ev.target.value } }))) reload(); }}>{tx.data!.categories.map((c) => <option key={c}>{c}</option>)}</select></td>
                  <td className="tabular whitespace-nowrap text-right font-medium">{t.amount > 0 ? "+" : ""}{eurCents(t.amount)}</td>
                  <td className="w-8 text-right"><button aria-label="Supprimer l'opération" title="Supprimer" onClick={async () => { if (await run(() => api(`/api/data/transactions?id=${t.id}`, { method: "DELETE" }))) reload(); }} className="rounded p-1 text-ink-3 hover:bg-surface-2 hover:text-critical">✕</button></td>
                </tr>
              ))}
              {tx.data?.transactions.length === 0 && <tr><td colSpan={5} className="py-6 text-center text-ink-3">Aucune opération. Importe un relevé pour que je mesure tes dépenses réelles.</td></tr>}
            </tbody>
          </table>
        </div>
      </Section>
    </Page>
  );
}
