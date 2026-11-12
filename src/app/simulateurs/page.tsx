"use client";

import { useMemo, useState } from "react";
import { Page, Section } from "@/components/AppShell";
import { BlockView } from "@/components/blocks/BlockView";
import { ProjectionBlock } from "@/components/blocks/ProjectionBlock";
import { useData } from "@/components/useData";
import type { Block } from "@/lib/ai/blocks";
import { compareRealEstateVsEtf } from "@/lib/engine/compare";
import { simulateLoan } from "@/lib/engine/loan";
import { eur, pct } from "@/lib/engine/money";
import type { RentalRegime } from "@/lib/engine/realestate";

const TABS = ["Investissement programmé", "Immobilier ou ETF", "Crédit"] as const;
type Tab = (typeof TABS)[number];

function NumberField({ label, value, onChange, step = 1, suffix }: { label: string; value: number; onChange: (v: number) => void; step?: number; suffix?: string }) {
  return (
    <label>
      <span className="label">{label}{suffix ? ` (${suffix})` : ""}</span>
      <input type="number" step={step} min={0} className="field tabular" value={Number.isFinite(value) ? value : ""} onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))} />
    </label>
  );
}

function RealEstate({ marginalRate }: { marginalRate: number }) {
  const [f, setF] = useState({ price: 120000, downPayment: 15000, rent: 650, years: 20, units: 1, rate: 3.4, loanYears: 25, vacancy: 1, regime: "micro_foncier" as RentalRegime, tmi: Math.round(marginalRate * 100) });
  const set = (k: keyof typeof f) => (v: number) => setF((prev) => ({ ...prev, [k]: v }));

  const result = useMemo(() => {
    try {
      return { ok: true as const, c: compareRealEstateVsEtf({ units: f.units, rental: { price: f.price, downPayment: f.downPayment, monthlyRent: f.rent, years: f.years, annualRate: f.rate / 100, loanYears: f.loanYears, vacancyMonthsPerYear: f.vacancy, regime: f.regime, marginalTaxRate: f.tmi / 100 } }) };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : "Paramètres invalides" };
    }
  }, [f]);

  const blocks: Block[] = [];
  if (result.ok) {
    const { c } = result;
    const verdict = { immobilier: "Immobilier devant", etf: "ETF devant", equivalent: "Équivalent" } as const;
    blocks.push(
      { type: "kpis", items: [
        { label: "Coût total par bien", value: eur(c.rentalCentral.totalCost), hint: "frais de notaire inclus" },
        { label: "Mensualité par bien", value: eur(c.rentalCentral.monthlyLoanPayment), hint: "assurance incluse" },
        { label: "Rendement net de charges", value: pct(c.rentalCentral.netYield), hint: `brut ${pct(c.rentalCentral.grossYield)}` },
        { label: "Effort mensuel moyen", value: eur(c.averageMonthlyEffort), hint: c.averageMonthlyEffort > 0 ? "à sortir de ta poche" : "le bien s'autofinance" },
      ] },
      { type: "scenarios", title: `Patrimoine net dans ${c.years} ans`, columns: ["Immobilier", "ETF"], rows: c.scenarios.map((s) => ({ scenario: s.scenario, a: s.realEstateNetWorth, b: s.etfNetWorth, verdict: verdict[s.winner] })), note: `Même apport (${eur(c.downPayment)}) et même effort mensuel des deux côtés. Dette contractée : ${eur(c.totalDebt)}.` },
      { type: "lines", title: "Scénario central, année par année", unit: "€", xLabel: "Années", series: [{ name: "Immobilier", points: c.series.map((p) => ({ x: p.year, y: p.immobilier })) }, { name: "ETF", points: c.series.map((p) => ({ x: p.year, y: p.etf })) }] },
      { type: "notice", tone: "info", title: "À garder en tête", items: c.notes },
    );
  }

  return (
    <>
      <Section title="Hypothèses du projet locatif">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <NumberField label="Prix du bien" suffix="€" step={1000} value={f.price} onChange={set("price")} />
          <NumberField label="Apport par bien" suffix="€" step={500} value={f.downPayment} onChange={set("downPayment")} />
          <NumberField label="Loyer mensuel" suffix="€" step={10} value={f.rent} onChange={set("rent")} />
          <NumberField label="Nombre de biens" value={f.units} onChange={(v) => set("units")(Math.max(1, Math.round(v)))} />
          <NumberField label="Taux du crédit" suffix="%" step={0.05} value={f.rate} onChange={set("rate")} />
          <NumberField label="Durée du crédit" suffix="ans" value={f.loanYears} onChange={(v) => set("loanYears")(Math.min(25, Math.max(5, v)))} />
          <NumberField label="Vacance locative" suffix="mois/an" step={0.5} value={f.vacancy} onChange={set("vacancy")} />
          <NumberField label="Horizon" suffix="ans" value={f.years} onChange={(v) => set("years")(Math.min(40, Math.max(1, Math.round(v))))} />
          <label><span className="label">Régime fiscal</span><select className="field" value={f.regime} onChange={(e) => setF({ ...f, regime: e.target.value as RentalRegime })}><option value="micro_foncier">Micro-foncier (nu)</option><option value="reel">Réel (nu)</option><option value="lmnp_micro_bic">Meublé micro-BIC</option></select></label>
          <label><span className="label">Tranche marginale d'imposition</span><select className="field" value={f.tmi} onChange={(e) => set("tmi")(Number(e.target.value))}>{[0, 11, 30, 41, 45].map((t) => <option key={t} value={t}>{t} %</option>)}</select></label>
        </div>
        {!result.ok && <p className="mt-3 text-sm text-critical">{result.error}</p>}
      </Section>
      <div className="space-y-4">{blocks.map((b, i) => <BlockView key={i} block={b} />)}</div>
    </>
  );
}

function Loan() {
  const [f, setF] = useState({ principal: 150000, rate: 3.4, years: 25, insurance: 0.3 });
  const set = (k: keyof typeof f) => (v: number) => setF((prev) => ({ ...prev, [k]: v }));
  const loan = useMemo(() => {
    try {
      return simulateLoan({ principal: f.principal, annualRate: f.rate / 100, years: Math.max(1, f.years), insuranceRate: f.insurance / 100 });
    } catch {
      return null;
    }
  }, [f]);
  return (
    <>
      <Section title="Paramètres du prêt">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <NumberField label="Capital emprunté" suffix="€" step={1000} value={f.principal} onChange={set("principal")} />
          <NumberField label="Taux annuel" suffix="%" step={0.05} value={f.rate} onChange={set("rate")} />
          <NumberField label="Durée" suffix="ans" value={f.years} onChange={(v) => set("years")(Math.min(30, v))} />
          <NumberField label="Assurance" suffix="% / an" step={0.05} value={f.insurance} onChange={set("insurance")} />
        </div>
      </Section>
      {loan && (
        <div className="space-y-4">
          <BlockView block={{ type: "kpis", items: [{ label: "Mensualité", value: eur(loan.monthlyTotal), hint: `dont assurance ${eur(loan.monthlyInsurance)}` }, { label: "Intérêts", value: eur(loan.totalInterest) }, { label: "Assurance", value: eur(loan.totalInsurance) }, { label: "Coût total du crédit", value: eur(loan.totalCost) }] }} />
          <BlockView block={{ type: "lines", title: "Capital restant dû", unit: "€", xLabel: "Années", series: [{ name: "Capital restant dû", points: [{ x: 0, y: f.principal }, ...loan.schedule.map((y) => ({ x: y.year, y: y.remaining }))] }] }} />
          <BlockView block={{ type: "table", title: "Tableau de remboursement", columns: ["Année", "Intérêts", "Capital remboursé", "Restant dû"], rows: loan.schedule.map((y) => [y.year, eur(y.interest), eur(y.principalRepaid), eur(y.remaining)]) }} />
        </div>
      )}
    </>
  );
}

export default function SimulateursPage() {
  const [tab, setTab] = useState<Tab>(TABS[0]);
  const overview = useData<{ tax: { marginalRate: number } | null; budget: { savingsCapacity: number | null } }>("/api/overview");
  const monthly = overview.data?.budget.savingsCapacity && overview.data.budget.savingsCapacity > 0 ? Math.round(overview.data.budget.savingsCapacity / 50) * 50 : 300;

  return (
    <Page title="Simulateurs" subtitle="Les mêmes calculs que ceux de l'assistant, en accès direct. Tout est calculé sur ton appareil, à partir d'hypothèses affichées.">
      <div role="tablist" className="mb-5 flex gap-1 overflow-x-auto rounded-xl border border-line bg-surface p-1">
        {TABS.map((t) => <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`shrink-0 rounded-lg px-3.5 py-2 text-sm ${tab === t ? "bg-accent-soft font-medium text-accent" : "text-ink-2 hover:bg-surface-2"}`}>{t}</button>)}
      </div>
      {tab === "Investissement programmé" && overview.data && <ProjectionBlock key={monthly} title="Investissement programmé en ETF actions mondiales" editableInitial params={{ initial: 0, monthly, years: 10, wrapper: "PEA", wrapperAgeYears: 0 }} />}
      {tab === "Immobilier ou ETF" && overview.data && <RealEstate marginalRate={overview.data.tax?.marginalRate ?? 0.3} />}
      {tab === "Crédit" && <Loan />}
    </Page>
  );
}
