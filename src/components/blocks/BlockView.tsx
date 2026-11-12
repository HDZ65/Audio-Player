"use client";

import { useState } from "react";
import { BarList } from "@/components/charts/BarList";
import { LineChart } from "@/components/charts/LineChart";
import type { Block } from "@/lib/ai/blocks";
import { api } from "@/lib/client";
import { eur } from "@/lib/engine/money";
import { SCENARIO_LABELS } from "@/lib/engine/params";
import { ProjectionBlock, SCENARIO_COLORS } from "./ProjectionBlock";

const SERIES_COLORS = ["var(--series-1)", "var(--series-2)", "var(--series-3)"];

function Card({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div className="card p-4 sm:p-5">
      {title && <h4 className="mb-3 text-sm font-semibold">{title}</h4>}
      {children}
    </div>
  );
}

function ActionBlock({ block }: { block: Extract<Block, { type: "action" }> }) {
  const [status, setStatus] = useState(block.status);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolve = async (next: "confirmee" | "annulee") => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ status: typeof status }>(`/api/data/actions?id=${block.actionId}`, { method: "PATCH", body: { status: next } });
      setStatus(r.status);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erreur");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card border-accent/40 p-4 sm:p-5">
      <p className="text-xs font-medium uppercase tracking-wide text-accent">Opération préparée — rien n'a été exécuté</p>
      <h4 className="mt-1 text-sm font-semibold">{block.title}</h4>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        {block.params.map((p) => (<div key={p.label} className="contents"><dt className="text-ink-3">{p.label}</dt><dd className="text-ink">{p.value}</dd></div>))}
      </dl>
      {status === "preparee" ? (
        <>
          <p className="mt-3 text-xs text-ink-3">Vérifie chaque paramètre. Confirmer consigne ton accord dans le journal ; l'opération reste à réaliser par toi chez ta banque ou ton courtier.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button className="btn btn-primary" disabled={busy} onClick={() => resolve("confirmee")}>Je confirme ces paramètres</button>
            <button className="btn btn-ghost" disabled={busy} onClick={() => resolve("annulee")}>Annuler</button>
          </div>
        </>
      ) : (
        <p className="mt-3 text-sm font-medium text-ink-2">{status === "confirmee" ? "✓ Paramètres confirmés. À réaliser toi-même auprès de ton établissement." : "✕ Opération annulée."}</p>
      )}
      {error && <p className="mt-2 text-xs text-critical">{error}</p>}
    </div>
  );
}

/** Affiche un bloc produit par un outil : les chiffres viennent du moteur, jamais du modèle. */
export function BlockView({ block }: { block: Block }) {
  switch (block.type) {
    case "kpis":
      return (
        <Card title={block.title}>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-4">
            {block.items.map((item) => (
              <div key={item.label}>
                <dt className="text-xs text-ink-3">{item.label}</dt>
                <dd className="tabular mt-0.5 text-lg font-semibold tracking-tight">{item.value}</dd>
                {item.hint && <dd className="text-xs text-ink-3">{item.hint}</dd>}
              </div>
            ))}
          </dl>
        </Card>
      );
    case "projection":
      return <ProjectionBlock title={block.title} params={block.params} monteCarlo={block.monteCarlo} />;
    case "options":
      return (
        <Card title={block.title}>
          <div className="grid gap-3 sm:grid-cols-2">
            {block.options.map((o) => (
              <div key={o.title} className={`rounded-xl border p-3.5 ${o.recommended ? "border-accent bg-accent-soft/50" : "border-line"}`}>
                {o.recommended && <span className="mb-1.5 inline-block rounded-full bg-accent px-2 py-0.5 text-[11px] font-semibold text-on-accent">Recommandé</span>}
                <h5 className="text-sm font-semibold leading-snug">{o.title}</h5>
                <p className="mt-1 text-xs text-ink-2">{o.split.map((s) => `${eur(s.amount)} → ${s.label}`).join(" · ")}</p>
                <p className="tabular mt-2 text-xs text-ink-3">Dans 5 ans : <span className="font-medium text-ink">{o.range.low === o.range.high ? eur(o.range.central) : `${eur(o.range.low)} à ${eur(o.range.high)}`}</span></p>
                <ul className="mt-2 space-y-1 text-xs text-ink-2">
                  {o.pros.map((x) => <li key={x} className="flex gap-1.5"><span aria-hidden="true" className="font-semibold text-ink">+</span><span><span className="sr-only">Avantage : </span>{x}</span></li>)}
                  {o.cons.map((x) => <li key={x} className="flex gap-1.5"><span aria-hidden="true" className="font-semibold text-ink">−</span><span><span className="sr-only">Inconvénient : </span>{x}</span></li>)}
                </ul>
              </div>
            ))}
          </div>
        </Card>
      );
    case "table":
      return (
        <Card title={block.title}>
          <div className="max-h-96 overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface"><tr className="border-b border-line text-left text-xs text-ink-3">{block.columns.map((c) => <th key={c} className="py-1.5 pr-3 font-medium">{c}</th>)}</tr></thead>
              <tbody className="tabular">{block.rows.map((row, i) => <tr key={i} className="border-b border-line/60">{row.map((cell, j) => <td key={j} className={`py-1.5 pr-3 ${j === 0 ? "text-ink" : "text-ink-2"}`}>{cell}</td>)}</tr>)}</tbody>
            </table>
          </div>
          {block.note && <p className="mt-3 text-xs text-ink-3">{block.note}</p>}
        </Card>
      );
    case "lines":
      return (
        <Card title={block.title}>
          <LineChart series={block.series.map((s, i) => ({ ...s, color: SERIES_COLORS[i % SERIES_COLORS.length]! }))} xLabel={block.xLabel} />
          {block.note && <p className="mt-2 text-xs text-ink-3">{block.note}</p>}
        </Card>
      );
    case "bars":
      return (
        <Card title={block.title}>
          <BarList items={block.items} unit={block.unit} />
          {block.note && <p className="mt-3 text-xs text-ink-3">{block.note}</p>}
        </Card>
      );
    case "scenarios":
      return (
        <Card title={block.title}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[380px] text-sm">
              <thead><tr className="border-b border-line text-left text-xs text-ink-3"><th className="py-1.5 font-medium">Scénario</th><th className="font-medium">{block.columns[0]}</th><th className="font-medium">{block.columns[1]}</th><th className="font-medium">Écart</th></tr></thead>
              <tbody className="tabular">
                {block.rows.map((r) => (
                  <tr key={r.scenario} className="border-b border-line/60">
                    <td className="py-2"><span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: SCENARIO_COLORS[r.scenario] }} />{SCENARIO_LABELS[r.scenario]}</span></td>
                    <td className={r.a >= r.b ? "font-semibold" : "text-ink-2"}>{eur(r.a)}</td>
                    <td className={r.b > r.a ? "font-semibold" : "text-ink-2"}>{eur(r.b)}</td>
                    <td className="text-ink-2">{r.verdict}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {block.note && <p className="mt-3 text-xs text-ink-3">{block.note}</p>}
        </Card>
      );
    case "plan":
      return (
        <Card title={block.title}>
          <ol className="space-y-3">{block.steps.map((s, i) => (<li key={s.title} className="flex gap-3"><span className="tabular flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent">{i + 1}</span><div><p className="text-sm font-medium">{s.title}</p><p className="text-sm text-ink-2">{s.detail}</p></div></li>))}</ol>
        </Card>
      );
    case "notice":
      return (
        <div className={`rounded-2xl border p-4 text-sm ${block.tone === "attention" ? "border-transparent bg-warning-soft" : "border-line bg-surface-2"}`}>
          <p className="mb-1.5 flex items-center gap-1.5 font-semibold"><span aria-hidden="true">{block.tone === "attention" ? "⚠" : "ℹ"}</span>{block.title}</p>
          <ul className="list-disc space-y-1 pl-5 text-ink-2">{block.items.map((x) => <li key={x}>{x}</li>)}</ul>
        </div>
      );
    case "memory":
      return (
        <ul className="flex flex-wrap gap-2">
          {block.items.map((x) => <li key={x} className="flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1 text-xs text-ink-2"><span aria-hidden="true">✓</span><span><span className="font-medium text-ink">Mémorisé</span> · {x}</span></li>)}
        </ul>
      );
    case "action":
      return <ActionBlock block={block} />;
    case "sources":
      return (
        <Card title="Sources consultées">
          <ul className="space-y-1 text-sm">{block.items.map((s) => <li key={s.url}><a href={s.url} target="_blank" rel="noopener noreferrer" className="text-accent underline-offset-2 hover:underline">{s.title}</a></li>)}</ul>
        </Card>
      );
  }
}
