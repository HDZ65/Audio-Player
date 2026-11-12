"use client";

import { useState } from "react";
import { Page, Section } from "@/components/AppShell";
import { LineChart } from "@/components/charts/LineChart";
import { toNumber, useAction, useData } from "@/components/useData";
import { api, frDate } from "@/lib/client";
import { eur, pct } from "@/lib/engine/money";

interface Goal { id: number; title: string; targetAmount: number; monthlyContribution: number | null; status: string; progress: number; current: number; createdAt: string; assumptions: Record<string, unknown>; forecasts: { date: string; projected: number }[] }
interface Data {
  goals: Goal[];
  decisions: { id: number; date: string; title: string; detail: string; status: string }[];
  simulations: { id: number; createdAt: string; kind: string; title: string }[];
  checks: { goal: string; date: string; projected: number; actual: number; gap: number }[];
  history: { date: string; total: number }[];
}

const KIND_LABELS: Record<string, string> = { allocation: "Allocation", investissement: "Investissement", immobilier: "Immobilier", comparaison: "Immobilier ou ETF" };

export default function ObjectifsPage() {
  const { data, error: loadError, reload } = useData<Data>("/api/data/goals");
  const { run, error, busy } = useAction();
  const [goal, setGoal] = useState({ title: "", targetAmount: "", monthlyContribution: "" });
  const [decision, setDecision] = useState({ title: "", detail: "" });

  const addGoal = async (e: React.FormEvent) => {
    e.preventDefault();
    const targetAmount = toNumber(goal.targetAmount);
    if (targetAmount === null) return;
    if (await run(() => api("/api/data/goals", { method: "POST", body: { title: goal.title, targetAmount, monthlyContribution: toNumber(goal.monthlyContribution) } }))) {
      setGoal({ title: "", targetAmount: "", monthlyContribution: "" });
      void reload();
    }
  };
  const addDecision = async (e: React.FormEvent) => {
    e.preventDefault();
    if (await run(() => api("/api/data/decisions", { method: "POST", body: decision }))) {
      setDecision({ title: "", detail: "" });
      void reload();
    }
  };

  return (
    <Page title="Objectifs et suivi" subtitle="Ce que tu vises, les hypothèses retenues, les décisions prises — et l'écart entre ce qui était prévu et ce qui s'est réellement passé.">
      {(loadError || error) && <p className="mb-4 rounded-lg bg-critical-soft px-3 py-2 text-sm text-critical">{loadError ?? error}</p>}

      <Section title="Objectifs" hint="Demande à l'assistant de construire un plan : il enregistre l'objectif, ses hypothèses et la trajectoire prévue.">
        <ul className="space-y-4">
          {(data?.goals ?? []).map((g) => {
            const start = new Date(g.createdAt).getFullYear();
            const points = g.forecasts.map((f) => ({ x: new Date(f.date).getFullYear() - start, y: f.projected })).filter((p) => p.y <= g.targetAmount * 1.25);
            return (
              <li key={g.id} className="rounded-xl border border-line p-4">
                <div className="flex items-start justify-between gap-3">
                  <div><h3 className="font-semibold">{g.title}</h3><p className="text-xs text-ink-3">Créé le {frDate(g.createdAt)}{g.monthlyContribution ? ` · ${eur(g.monthlyContribution)} par mois prévus` : ""}</p></div>
                  <button aria-label={`Supprimer l'objectif ${g.title}`} title="Supprimer" onClick={async () => { if (confirm(`Supprimer l'objectif « ${g.title} » ?`) && await run(() => api(`/api/data/goals?id=${g.id}`, { method: "DELETE" }))) void reload(); }} className="rounded p-1 text-ink-3 hover:bg-surface-2 hover:text-critical">✕</button>
                </div>
                <div className="mt-3 flex items-baseline justify-between text-sm"><span className="tabular font-semibold">{eur(g.current)}</span><span className="tabular text-ink-3">{pct(g.progress)} de {eur(g.targetAmount)}</span></div>
                <div className="mt-1.5 h-2.5 rounded-full bg-surface-2" role="progressbar" aria-valuenow={Math.round(g.progress * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={`Progression de ${g.title}`}><div className="h-2.5 rounded-full" style={{ width: `${Math.max(1, g.progress * 100)}%`, background: "var(--series-1)" }} /></div>
                {points.length > 1 && (
                  <div className="mt-4">
                    <LineChart height={200} xLabel="Années depuis la création du plan" series={[{ name: "Trajectoire prévue (scénario central)", color: "var(--series-1)", points: [{ x: 0, y: Number(g.assumptions.patrimoineDepart ?? g.current) }, ...points] }]} />
                    <p className="text-xs text-ink-3">Hypothèse de simulation enregistrée à la création du plan, pas une prévision garantie.</p>
                  </div>
                )}
              </li>
            );
          })}
          {data?.goals.length === 0 && <li className="py-2 text-sm text-ink-3">Aucun objectif enregistré.</li>}
        </ul>
        <form onSubmit={addGoal} className="mt-4 grid gap-3 border-t border-line pt-4 sm:grid-cols-[2fr_1fr_1fr_auto] sm:items-end">
          <label><span className="label">Objectif</span><input required className="field" value={goal.title} onChange={(e) => setGoal({ ...goal, title: e.target.value })} placeholder="Atteindre 100 000 € de patrimoine" /></label>
          <label><span className="label">Montant cible (€)</span><input required inputMode="decimal" className="field tabular" value={goal.targetAmount} onChange={(e) => setGoal({ ...goal, targetAmount: e.target.value })} /></label>
          <label><span className="label">Versement mensuel (€)</span><input inputMode="decimal" className="field tabular" value={goal.monthlyContribution} onChange={(e) => setGoal({ ...goal, monthlyContribution: e.target.value })} placeholder="optionnel" /></label>
          <button className="btn btn-primary" disabled={busy}>Ajouter</button>
        </form>
      </Section>

      <Section title="Prévisions passées et réalité" hint="Chaque plan enregistre sa trajectoire. Quand une échéance est passée, je compare ce que j'avais projeté à ton patrimoine observé.">
        {data && data.checks.length > 0 ? (
          <table className="w-full text-sm">
            <thead><tr className="border-b border-line text-left text-xs text-ink-3"><th className="py-2 font-medium">Objectif</th><th className="font-medium">Échéance</th><th className="font-medium">Prévu</th><th className="font-medium">Observé</th><th className="font-medium">Écart</th></tr></thead>
            <tbody className="tabular">{data.checks.map((c) => <tr key={c.goal + c.date} className="border-b border-line/60"><td className="py-2">{c.goal}</td><td>{frDate(c.date)}</td><td>{eur(c.projected)}</td><td>{eur(c.actual)}</td><td className="font-medium">{c.gap >= 0 ? "+" : "−"}{eur(Math.abs(c.gap))}</td></tr>)}</tbody>
          </table>
        ) : <p className="text-sm text-ink-3">Aucune échéance de prévision n'est encore passée. La première comparaison apparaîtra un an après la création d'un plan.</p>}
        {data && data.history.length > 1 && (
          <div className="mt-4"><LineChart height={200} xLabel="Relevés successifs" series={[{ name: "Patrimoine net observé", color: "var(--series-1)", points: data.history.map((h, i) => ({ x: i + 1, y: h.total })) }]} /></div>
        )}
      </Section>

      <Section title="Décisions" hint="Une décision est consignée avec les hypothèses du moment (salaire, dépenses, patrimoine). Si elles changent nettement, l'assistant te le signale.">
        <ul className="space-y-2">
          {(data?.decisions ?? []).map((d) => (
            <li key={d.id} className="flex items-start justify-between gap-3 rounded-xl border border-line p-3">
              <div><p className="text-sm font-medium">{d.title} <span className="font-normal text-ink-3">· {frDate(d.date)}</span></p><p className="text-sm text-ink-2">{d.detail}</p></div>
              <button aria-label={`Supprimer la décision ${d.title}`} title="Supprimer" onClick={async () => { if (await run(() => api(`/api/data/decisions?id=${d.id}`, { method: "DELETE" }))) void reload(); }} className="rounded p-1 text-ink-3 hover:bg-surface-2 hover:text-critical">✕</button>
            </li>
          ))}
          {data?.decisions.length === 0 && <li className="text-sm text-ink-3">Aucune décision consignée.</li>}
        </ul>
        <form onSubmit={addDecision} className="mt-4 grid gap-3 border-t border-line pt-4 sm:grid-cols-[1fr_2fr_auto] sm:items-end">
          <label><span className="label">Décision</span><input required minLength={3} className="field" value={decision.title} onChange={(e) => setDecision({ ...decision, title: e.target.value })} placeholder="Investir 300 € par mois" /></label>
          <label><span className="label">Pourquoi, et à quelles conditions</span><input required minLength={3} className="field" value={decision.detail} onChange={(e) => setDecision({ ...decision, detail: e.target.value })} placeholder="ETF Monde sur le PEA, tant que mon épargne de précaution dépasse 3 mois" /></label>
          <button className="btn btn-primary" disabled={busy}>Consigner</button>
        </form>
      </Section>

      <Section title="Analyses précédentes" hint="Les simulations lancées dans la conversation, avec leurs paramètres, sont conservées.">
        <ul className="divide-y divide-line/60 text-sm">
          {(data?.simulations ?? []).map((s) => <li key={s.id} className="flex items-baseline justify-between gap-3 py-2"><span><span className="mr-2 rounded bg-surface-2 px-1.5 py-0.5 text-xs text-ink-2">{KIND_LABELS[s.kind] ?? s.kind}</span>{s.title}</span><span className="shrink-0 text-xs text-ink-3">{frDate(s.createdAt)}</span></li>)}
          {data?.simulations.length === 0 && <li className="py-2 text-ink-3">Aucune simulation pour l'instant.</li>}
        </ul>
      </Section>
    </Page>
  );
}
