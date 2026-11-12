"use client";

import { useMemo, useState } from "react";
import { LineChart } from "@/components/charts/LineChart";
import { eur, pct } from "@/lib/engine/money";
import { MARKET, SCENARIO_LABELS, SCENARIO_NAMES, type ScenarioName } from "@/lib/engine/params";
import { projectScenarios, type Wrapper } from "@/lib/engine/projection";

export const SCENARIO_COLORS: Record<ScenarioName, string> = { prudent: "var(--series-2)", central: "var(--series-1)", favorable: "var(--series-3)" };

export interface ProjectionParams {
  initial: number;
  monthly: number;
  years: number;
  wrapper: Wrapper;
  wrapperAgeYears: number;
}

/** Simulateur interactif : les curseurs recalculent la projection avec le même moteur que le serveur. */
export function ProjectionBlock({ title, params, monteCarlo, editableInitial = false }: {
  title: string;
  params: ProjectionParams;
  monteCarlo?: { p10: number; p50: number; p90: number; probabilityOfLoss: number; medianMaxDrawdown: number; paths: number };
  editableInitial?: boolean;
}) {
  const [monthly, setMonthly] = useState(params.monthly);
  const [years, setYears] = useState(params.years);
  const [initial, setInitial] = useState(params.initial);
  const [wrapper, setWrapper] = useState<Wrapper>(params.wrapper);
  const [view, setView] = useState<"graphique" | "tableau">("graphique");

  const scenarios = useMemo(() => projectScenarios({ initial, monthly, years, wrapper, wrapperAgeYears: params.wrapperAgeYears }), [initial, monthly, years, wrapper, params.wrapperAgeYears]);
  const untouched = monthly === params.monthly && years === params.years && initial === params.initial && wrapper === params.wrapper;
  const maxMonthly = Math.max(2000, Math.ceil((params.monthly * 2) / 100) * 100);

  const series = [
    ...SCENARIO_NAMES.map((n) => ({ name: `${SCENARIO_LABELS[n]} (${pct(MARKET.scenarios.value[n])}/an)`, color: SCENARIO_COLORS[n], points: scenarios[n].points.map((p) => ({ x: p.year, y: p.netValue })) })),
    { name: "Total versé", color: "var(--series-neutral)", dashed: true, points: scenarios.central.points.map((p) => ({ x: p.year, y: p.contributed })) },
  ];

  return (
    <div className="card p-4 sm:p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">{untouched ? title : `${eur(monthly)} par mois pendant ${years} ans`}</h4>
        <div role="tablist" className="flex rounded-lg border border-line p-0.5 text-xs">
          {(["graphique", "tableau"] as const).map((v) => (
            <button key={v} role="tab" aria-selected={view === v} onClick={() => setView(v)} className={`rounded-md px-2.5 py-1 capitalize ${view === v ? "bg-surface-2 font-medium text-ink" : "text-ink-3"}`}>{v}</button>
          ))}
        </div>
      </div>

      <div className="mb-4 grid gap-x-6 gap-y-3 sm:grid-cols-2">
        <label className="block text-xs text-ink-2">
          <span className="flex justify-between"><span>Versement mensuel</span><span className="tabular font-medium text-ink">{eur(monthly)}</span></span>
          <input type="range" min={0} max={maxMonthly} step={25} value={monthly} onChange={(e) => setMonthly(Number(e.target.value))} className="mt-1 w-full" />
        </label>
        <label className="block text-xs text-ink-2">
          <span className="flex justify-between"><span>Durée</span><span className="tabular font-medium text-ink">{years} ans</span></span>
          <input type="range" min={1} max={40} step={1} value={years} onChange={(e) => setYears(Number(e.target.value))} className="mt-1 w-full" />
        </label>
        {editableInitial && (
          <label className="block text-xs text-ink-2">
            <span className="flex justify-between"><span>Capital de départ</span><span className="tabular font-medium text-ink">{eur(initial)}</span></span>
            <input type="range" min={0} max={100000} step={500} value={initial} onChange={(e) => setInitial(Number(e.target.value))} className="mt-1 w-full" />
          </label>
        )}
        <label className="block text-xs text-ink-2">
          <span>Enveloppe fiscale</span>
          <select value={wrapper} onChange={(e) => setWrapper(e.target.value as Wrapper)} className="field mt-1 !py-1.5">
            <option value="PEA">PEA (prélèvements sociaux seuls après 5 ans)</option>
            <option value="CTO">Compte-titres (flat tax)</option>
          </select>
        </label>
      </div>

      {view === "graphique" ? (
        <LineChart series={series} xLabel="Années" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[440px] text-sm">
            <thead><tr className="border-b border-line text-left text-xs text-ink-3"><th className="py-1.5 font-medium">Année</th><th className="font-medium">Versé</th>{SCENARIO_NAMES.map((n) => <th key={n} className="font-medium">{SCENARIO_LABELS[n]}</th>)}</tr></thead>
            <tbody className="tabular">
              {scenarios.central.points.filter((p) => p.year > 0 && (years <= 12 || p.year % 5 === 0 || p.year === years)).map((p) => (
                <tr key={p.year} className="border-b border-line/60"><td className="py-1.5">{p.year}</td><td>{eur(p.contributed)}</td>{SCENARIO_NAMES.map((n) => <td key={n}>{eur(scenarios[n].points.find((q) => q.year === p.year)?.netValue ?? 0)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-line pt-3 text-sm sm:grid-cols-4">
        <div><dt className="text-xs text-ink-3">Total versé</dt><dd className="tabular font-semibold">{eur(scenarios.central.final.contributed)}</dd></div>
        {SCENARIO_NAMES.map((n) => (
          <div key={n}>
            <dt className="flex items-center gap-1.5 text-xs text-ink-3"><span className="h-2 w-2 rounded-full" style={{ background: SCENARIO_COLORS[n] }} />{SCENARIO_LABELS[n]}</dt>
            <dd className="tabular font-semibold">{eur(scenarios[n].final.netValue)}</dd>
            <dd className="tabular text-xs text-ink-3">{eur(scenarios[n].final.realNetValue)} en euros d'aujourd'hui</dd>
          </div>
        ))}
      </dl>

      {monteCarlo && untouched && (
        <p className="mt-3 rounded-lg bg-surface-2 p-3 text-xs leading-relaxed text-ink-2">
          Avec des rendements variables ({monteCarlo.paths.toLocaleString("fr-FR")} trajectoires simulées, avant impôts) : 8 sur 10 terminent entre <strong className="text-ink">{eur(monteCarlo.p10)}</strong> et <strong className="text-ink">{eur(monteCarlo.p90)}</strong>, médiane {eur(monteCarlo.p50)}. {pct(monteCarlo.probabilityOfLoss)} terminent sous le total versé. Baisse maximale typique en cours de route : {pct(monteCarlo.medianMaxDrawdown)}.
        </p>
      )}
      <p className="mt-3 text-xs text-ink-3">Valeurs nettes de frais ({pct(MARKET.etfFees.value)}/an) et d'impôts de sortie. Hypothèses de simulation, pas des prévisions : aucun rendement n'est garanti.</p>
    </div>
  );
}
