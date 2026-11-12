"use client";

import { useState } from "react";
import { Page, Section } from "@/components/AppShell";
import { BarList } from "@/components/charts/BarList";
import { toNumber, useAction, useData } from "@/components/useData";
import { ASSET_LABELS, KIND_LABELS, api, frDate } from "@/lib/client";
import { eur, eurCents } from "@/lib/engine/money";

interface Account { id: number; name: string; institution: string | null; kind: string; balance: number; asOf: string; source: string }
interface Holding { id: number; accountId: number | null; name: string; ticker: string | null; assetClass: string; sector: string | null; value: number | null; asOf: string | null }
interface Overview { netWorth: { total: number; liquid: number; invested: number; debts: number }; asOf: string | null }

function BalanceCell({ account, onSaved }: { account: Account; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(account.balance).replace(".", ","));
  const { run, error } = useAction();
  const save = async () => {
    const balance = toNumber(value);
    if (balance === null) return;
    if (await run(() => api(`/api/data/accounts?id=${account.id}`, { method: "PATCH", body: { balance } }))) {
      setEditing(false);
      onSaved();
    }
  };
  if (!editing) return <button onClick={() => setEditing(true)} title="Mettre à jour le solde" className="tabular rounded px-1 font-semibold underline decoration-dotted underline-offset-4 hover:bg-surface-2">{eurCents(account.balance)}</button>;
  return (
    <form onSubmit={(e) => { e.preventDefault(); void save(); }} className="flex items-center justify-end gap-1.5">
      <input autoFocus inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} aria-label={`Nouveau solde de ${account.name}`} className="field tabular !w-28 !py-1 text-right" />
      <button className="btn btn-primary !px-2 !py-1 text-xs">OK</button>
      {error && <span className="text-xs text-critical">{error}</span>}
    </form>
  );
}

export default function PatrimoinePage() {
  const accounts = useData<Account[]>("/api/data/accounts");
  const holdings = useData<Holding[]>("/api/data/holdings");
  const overview = useData<Overview>("/api/overview");
  const { run, error, busy } = useAction();
  const [account, setAccount] = useState({ name: "", institution: "", kind: "courant", balance: "" });
  const [holding, setHolding] = useState({ name: "", assetClass: "action", sector: "", value: "", accountId: "" });

  const reload = () => { void accounts.reload(); void holdings.reload(); void overview.reload(); };

  const addAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    const balance = toNumber(account.balance);
    if (balance === null) return;
    if (await run(() => api("/api/data/accounts", { method: "POST", body: { name: account.name, institution: account.institution || null, kind: account.kind, balance } }))) {
      setAccount({ name: "", institution: "", kind: "courant", balance: "" });
      reload();
    }
  };
  const addHolding = async (e: React.FormEvent) => {
    e.preventDefault();
    if (await run(() => api("/api/data/holdings", { method: "POST", body: { name: holding.name, assetClass: holding.assetClass, sector: holding.sector || null, value: toNumber(holding.value), accountId: holding.accountId ? Number(holding.accountId) : null } }))) {
      setHolding({ name: "", assetClass: "action", sector: "", value: "", accountId: "" });
      reload();
    }
  };
  const setHoldingValue = async (h: Holding, raw: string) => {
    const value = raw.trim() === "" ? null : toNumber(raw);
    if (raw.trim() !== "" && value === null) return;
    if (value === h.value) return;
    if (await run(() => api(`/api/data/holdings?id=${h.id}`, { method: "PATCH", body: { name: h.name, value } }))) reload();
  };

  const nw = overview.data?.netWorth;
  const investmentAccounts = (accounts.data ?? []).filter((a) => ["pea", "cto", "assurance_vie"].includes(a.kind));
  const valued = (holdings.data ?? []).filter((h) => h.value !== null && h.value > 0);

  return (
    <Page title="Patrimoine" subtitle="Tes comptes et tes placements. Les soldes sont des photographies datées : mets-les à jour quand ils changent, l'historique est conservé.">
      {(accounts.error || error) && <p className="mb-4 rounded-lg bg-critical-soft px-3 py-2 text-sm text-critical">{accounts.error ?? error}</p>}

      {nw && (
        <dl className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[{ l: "Patrimoine net", v: nw.total }, { l: "Épargne disponible", v: nw.liquid }, { l: "Placements", v: nw.invested }, { l: "Dettes", v: nw.debts }].map((k) => (
            <div key={k.l} className="card px-4 py-3"><dt className="text-xs text-ink-3">{k.l}</dt><dd className="tabular mt-1 text-xl font-semibold tracking-tight">{eur(k.v)}</dd></div>
          ))}
        </dl>
      )}

      <Section title="Comptes" hint="Clique sur un solde pour le mettre à jour.">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-sm">
            <thead><tr className="border-b border-line text-left text-xs text-ink-3"><th className="py-2 font-medium">Compte</th><th className="font-medium">Type</th><th className="font-medium">Solde au</th><th className="text-right font-medium">Solde</th><th /></tr></thead>
            <tbody>
              {(accounts.data ?? []).map((a) => (
                <tr key={a.id} className="border-b border-line/60">
                  <td className="py-2.5"><span className="font-medium">{a.name}</span>{a.institution && a.institution !== a.name.split(" ")[0] && <span className="block text-xs text-ink-3">{a.institution}</span>}</td>
                  <td className="text-ink-2">{KIND_LABELS[a.kind] ?? a.kind}</td>
                  <td className="text-ink-2">{frDate(a.asOf)}</td>
                  <td className="text-right"><BalanceCell account={a} onSaved={reload} /></td>
                  <td className="w-8 text-right"><button aria-label={`Archiver ${a.name}`} title="Archiver" onClick={async () => { if (confirm(`Archiver « ${a.name} » ? Il ne comptera plus dans ton patrimoine.`) && await run(() => api(`/api/data/accounts?id=${a.id}`, { method: "DELETE" }))) reload(); }} className="rounded p-1 text-ink-3 hover:bg-surface-2 hover:text-critical">✕</button></td>
                </tr>
              ))}
              {accounts.data?.length === 0 && <tr><td colSpan={5} className="py-6 text-center text-ink-3">Aucun compte pour l'instant.</td></tr>}
            </tbody>
          </table>
        </div>
        <form onSubmit={addAccount} className="mt-4 grid gap-3 border-t border-line pt-4 sm:grid-cols-[2fr_1.5fr_1.5fr_1fr_auto] sm:items-end">
          <label><span className="label">Nom du compte</span><input required className="field" value={account.name} onChange={(e) => setAccount({ ...account, name: e.target.value })} placeholder="Livret A" /></label>
          <label><span className="label">Établissement</span><input className="field" value={account.institution} onChange={(e) => setAccount({ ...account, institution: e.target.value })} placeholder="BoursoBank" /></label>
          <label><span className="label">Type</span><select className="field" value={account.kind} onChange={(e) => setAccount({ ...account, kind: e.target.value })}>{Object.entries(KIND_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <label><span className="label">Solde (€)</span><input required inputMode="decimal" className="field tabular" value={account.balance} onChange={(e) => setAccount({ ...account, balance: e.target.value })} placeholder="0,00" /></label>
          <button className="btn btn-primary" disabled={busy}>Ajouter</button>
        </form>
      </Section>

      <Section title="Lignes de portefeuille" hint="Renseigne la valeur de chaque ligne telle qu'affichée par ton courtier. Aucun cours n'est récupéré ni estimé automatiquement.">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead><tr className="border-b border-line text-left text-xs text-ink-3"><th className="py-2 font-medium">Titre</th><th className="font-medium">Nature</th><th className="font-medium">Compte</th><th className="font-medium">Valeur au</th><th className="text-right font-medium">Valeur (€)</th><th /></tr></thead>
            <tbody>
              {(holdings.data ?? []).map((h) => (
                <tr key={h.id} className="border-b border-line/60">
                  <td className="py-2"><span className="font-medium">{h.name}</span>{h.sector && <span className="block text-xs text-ink-3">{h.sector}</span>}</td>
                  <td className="text-ink-2">{ASSET_LABELS[h.assetClass] ?? h.assetClass}</td>
                  <td>
                    <select aria-label={`Compte de ${h.name}`} className="field !w-auto !py-1 text-xs" value={h.accountId ?? ""} onChange={async (e) => { if (await run(() => api(`/api/data/holdings?id=${h.id}`, { method: "PATCH", body: { name: h.name, accountId: e.target.value ? Number(e.target.value) : null } }))) reload(); }}>
                      <option value="">Non rattaché</option>
                      {investmentAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                  </td>
                  <td className="text-ink-2">{h.value !== null ? frDate(h.asOf) : <span className="text-ink-3">inconnue</span>}</td>
                  <td className="text-right"><input key={`${h.id}-${h.value}`} aria-label={`Valeur de ${h.name}`} inputMode="decimal" defaultValue={h.value !== null ? String(h.value).replace(".", ",") : ""} placeholder="—" onBlur={(e) => setHoldingValue(h, e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} className="field tabular !w-28 !py-1 text-right" /></td>
                  <td className="w-8 text-right"><button aria-label={`Supprimer ${h.name}`} title="Supprimer" onClick={async () => { if (confirm(`Supprimer la ligne « ${h.name} » ?`) && await run(() => api(`/api/data/holdings?id=${h.id}`, { method: "DELETE" }))) reload(); }} className="rounded p-1 text-ink-3 hover:bg-surface-2 hover:text-critical">✕</button></td>
                </tr>
              ))}
              {holdings.data?.length === 0 && <tr><td colSpan={6} className="py-6 text-center text-ink-3">Aucune ligne pour l'instant.</td></tr>}
            </tbody>
          </table>
        </div>
        <form onSubmit={addHolding} className="mt-4 grid gap-3 border-t border-line pt-4 sm:grid-cols-[2fr_1fr_1.3fr_1.5fr_1fr_auto] sm:items-end">
          <label><span className="label">Titre</span><input required className="field" value={holding.name} onChange={(e) => setHolding({ ...holding, name: e.target.value })} placeholder="ETF Monde" /></label>
          <label><span className="label">Nature</span><select className="field" value={holding.assetClass} onChange={(e) => setHolding({ ...holding, assetClass: e.target.value })}>{Object.entries(ASSET_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <label><span className="label">Secteur</span><input className="field" value={holding.sector} onChange={(e) => setHolding({ ...holding, sector: e.target.value })} placeholder="Technologie" /></label>
          <label><span className="label">Compte</span><select className="field" value={holding.accountId} onChange={(e) => setHolding({ ...holding, accountId: e.target.value })}><option value="">Non rattaché</option>{investmentAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
          <label><span className="label">Valeur (€)</span><input inputMode="decimal" className="field tabular" value={holding.value} onChange={(e) => setHolding({ ...holding, value: e.target.value })} placeholder="optionnel" /></label>
          <button className="btn btn-primary" disabled={busy}>Ajouter</button>
        </form>
      </Section>

      {valued.length > 0 && (
        <Section title="Répartition des lignes valorisées">
          <BarList unit="€" items={valued.map((h) => ({ label: h.name, value: h.value! }))} />
        </Section>
      )}
    </Page>
  );
}
