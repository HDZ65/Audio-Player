"use client";

import { useState } from "react";
import { Page, Section } from "@/components/AppShell";
import { toNumber, useAction, useData } from "@/components/useData";
import { STATUS_LABELS, api, frDate } from "@/lib/client";
import { CREDIT, MARKET, SAFETY, SAVINGS, TAX, type Param } from "@/lib/engine/params";

interface Fact { id: number; key: string; category: string; label: string; value: string | null; status: string; source: string; asOf: string; history: { value: string | null; asOf: string }[] }
interface Data { facts: Fact[]; audit: { at: string; actor: string; action: string; detail: string }[] }
interface Overview { isEmpty: boolean; missing: string[]; stale: string[]; engine: { kind: string; name: string; webSearch: boolean }; authEnabled: boolean }

const CATEGORY_LABELS: Record<string, string> = { revenu: "Revenus", charge: "Charges", profil: "Profil d'investisseur", fiscal: "Fiscalité", projet: "Projets", objectif: "Objectifs", preference: "Préférences", autre: "Autres" };
const PARAM_STATUS: Record<string, string> = { fait: "Fait publié", a_verifier: "À vérifier", hypothese: "Hypothèse" };
const ACTORS: Record<string, string> = { utilisateur: "Toi", ia: "Assistant", systeme: "Système" };

const display = (p: Param<unknown>): string => {
  const v = p.value;
  if (typeof v === "number") return v < 1 ? `${(v * 100).toLocaleString("fr-FR", { maximumFractionDigits: 2 })} %` : v.toLocaleString("fr-FR");
  if (Array.isArray(v)) return (v as { upTo: number; rate: number }[]).map((b) => `${Math.round(b.rate * 100)} %${Number.isFinite(b.upTo) ? ` jusqu'à ${b.upTo.toLocaleString("fr-FR")} €` : " au-delà"}`).join(" · ");
  return Object.entries(v as Record<string, number>).map(([k, x]) => `${k} ${(x * 100).toLocaleString("fr-FR")} %`).join(" · ");
};

function StatusBadge({ status }: { status: string }) {
  const tone = status === "verifie" ? "bg-surface-2 text-ink-2" : status === "estime" ? "bg-warning-soft text-ink" : "bg-critical-soft text-critical";
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${tone}`}>{STATUS_LABELS[status] ?? status}</span>;
}

export default function MemoirePage() {
  const { data, error: loadError, reload } = useData<Data>("/api/data/facts");
  const overview = useData<Overview>("/api/overview");
  const { run, error, busy } = useAction();
  const [fact, setFact] = useState({ label: "", value: "", category: "projet", status: "verifie" });
  const [situation, setSituation] = useState("");
  const [wipe, setWipe] = useState("");

  const refresh = () => { void reload(); void overview.reload(); };
  const addFact = async (e: React.FormEvent) => {
    e.preventDefault();
    const slug = fact.label.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 60);
    if (!slug) return;
    if (await run(() => api("/api/data/facts", { method: "POST", body: { key: `${fact.category}.${slug}`, category: fact.category, label: fact.label, value: fact.value, numericValue: toNumber(fact.value), status: fact.status } }))) {
      setFact({ label: "", value: "", category: "projet", status: "verifie" });
      refresh();
    }
  };
  const importSituation = async () => {
    await run(async () => {
      await api("/api/import", { method: "POST", body: { type: "situation", situation: JSON.parse(situation) } });
      setSituation("");
      refresh();
    });
  };
  const wipeAll = async () => {
    if (await run(() => api("/api/export", { method: "DELETE", body: { confirmation: wipe } }))) {
      setWipe("");
      refresh();
    }
  };

  const groups = new Map<string, Fact[]>();
  for (const f of data?.facts ?? []) groups.set(f.category, [...(groups.get(f.category) ?? []), f]);
  const o = overview.data;

  return (
    <Page title="Mémoire" subtitle="Tout ce que l'assistant sait de toi, d'où ça vient et de quand ça date. Tu peux tout corriger, tout exporter, tout effacer.">
      {(loadError || error) && <p className="mb-4 rounded-lg bg-critical-soft px-3 py-2 text-sm text-critical">{loadError ?? error}</p>}

      {o && (o.missing.length > 0 || o.stale.length > 0) && (
        <Section title="Ce qui manque ou vieillit" hint="Ces informations limitent la précision des analyses.">
          <ul className="list-disc space-y-1 pl-5 text-sm text-ink-2">
            {o.missing.map((m) => <li key={m}><span className="font-medium text-ink">Manquant</span> · {m}</li>)}
            {o.stale.map((m) => <li key={m}><span className="font-medium text-ink">Ancien</span> · {m}</li>)}
          </ul>
        </Section>
      )}

      <Section title="Faits mémorisés" hint="Vérifié : tu l'as affirmé. Estimation : ordre de grandeur. Manquant : jamais deviné à ta place.">
        {[...groups.entries()].map(([category, facts]) => (
          <div key={category} className="mb-4 last:mb-0">
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-3">{CATEGORY_LABELS[category] ?? category}</h3>
            <ul className="divide-y divide-line/60">
              {facts.map((f) => (
                <li key={f.id} className="flex items-start justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="text-sm"><span className="text-ink-2">{f.label} : </span><span className="font-medium">{f.value ?? "non renseigné"}</span></p>
                    <p className="text-xs text-ink-3">Source : {f.source} · au {frDate(f.asOf)}{f.history.length > 0 ? ` · auparavant : ${f.history.slice(0, 3).map((h) => `${h.value ?? "—"} (${frDate(h.asOf)})`).join(", ")}` : ""}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2"><StatusBadge status={f.status} /><button aria-label={`Oublier ${f.label}`} title="Oublier" onClick={async () => { if (confirm(`Oublier « ${f.label} » ?`) && await run(() => api(`/api/data/facts?id=${f.id}`, { method: "DELETE" }))) refresh(); }} className="rounded p-1 text-ink-3 hover:bg-surface-2 hover:text-critical">✕</button></div>
                </li>
              ))}
            </ul>
          </div>
        ))}
        {data?.facts.length === 0 && <p className="text-sm text-ink-3">La mémoire est vide.</p>}
        <form onSubmit={addFact} className="mt-4 grid gap-3 border-t border-line pt-4 sm:grid-cols-[1.5fr_1.5fr_1fr_1fr_auto] sm:items-end">
          <label><span className="label">Information</span><input required minLength={2} className="field" value={fact.label} onChange={(e) => setFact({ ...fact, label: e.target.value })} placeholder="Prime annuelle attendue" /></label>
          <label><span className="label">Valeur</span><input required className="field" value={fact.value} onChange={(e) => setFact({ ...fact, value: e.target.value })} placeholder="2 000 € en mars" /></label>
          <label><span className="label">Catégorie</span><select className="field" value={fact.category} onChange={(e) => setFact({ ...fact, category: e.target.value })}>{Object.entries(CATEGORY_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <label><span className="label">Fiabilité</span><select className="field" value={fact.status} onChange={(e) => setFact({ ...fact, status: e.target.value })}><option value="verifie">Vérifié</option><option value="estime">Estimation</option></select></label>
          <button className="btn btn-primary" disabled={busy}>Mémoriser</button>
        </form>
      </Section>

      <Section title="Hypothèses de calcul" hint="Paramètres fiscaux et de marché utilisés par le moteur, avec leur date et leur source. Les hypothèses de marché sont des conventions de simulation, jamais des prévisions.">
        <div className="max-h-96 overflow-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="sticky top-0 bg-surface"><tr className="border-b border-line text-left text-xs text-ink-3"><th className="py-2 font-medium">Paramètre</th><th className="font-medium">Valeur</th><th className="font-medium">Nature</th><th className="font-medium">Source</th></tr></thead>
            <tbody>
              {[TAX, SAVINGS, CREDIT, MARKET, SAFETY].flatMap((group) => Object.values(group) as Param<unknown>[]).map((p) => (
                <tr key={p.label} className="border-b border-line/60 align-top"><td className="py-2 pr-3">{p.label}</td><td className="tabular pr-3 font-medium">{display(p)}</td><td className="whitespace-nowrap pr-3 text-ink-2">{PARAM_STATUS[p.status]}</td><td className="text-xs text-ink-3">{p.source} · {frDate(p.asOf)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {o && (
        <Section title="Confidentialité et fonctionnement">
          <ul className="space-y-2 text-sm text-ink-2">
            <li><span className="font-medium text-ink">Stockage</span> · Tes données sont dans une base locale sur la machine qui fait tourner l'application. Aucun identifiant bancaire n'est demandé ni stocké, et aucune connexion à ta banque n'existe.</li>
            <li><span className="font-medium text-ink">Assistant</span> · {o.engine.kind === "modele" ? `Les analyses sont rédigées par ${o.engine.name}. Pour cela, ta situation chiffrée (montants, noms de comptes, objectifs) est transmise à l'API d'Anthropic à chaque message.` : "Mode local : aucune donnée ne quitte cette machine. Les réponses suivent des règles fixes ; avec une clé API Anthropic, l'assistant comprend n'importe quelle question."} {o.engine.webSearch ? "La recherche web est activée." : "La recherche web est désactivée : l'assistant ne connaît ni les cours ni l'actualité."}</li>
            <li><span className="font-medium text-ink">Accès</span> · {o.authEnabled ? "Protégé par mot de passe." : "Aucun mot de passe configuré : à réserver à un usage sur ta propre machine. Définis APP_PASSWORD avant toute mise en ligne."}</li>
            <li><span className="font-medium text-ink">Actions</span> · L'assistant peut lire, calculer, mémoriser et préparer. Il n'exécute aucun achat, vente, virement ou souscription.</li>
          </ul>
          <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-line pt-4">
            <a href="/api/export" className="btn btn-ghost">Exporter toutes mes données (JSON)</a>
            {o.authEnabled && <button className="btn btn-ghost" onClick={async () => { await api("/api/auth", { method: "DELETE" }); window.location.href = "/login"; }}>Se déconnecter</button>}
            <label className="ml-auto"><span className="label">Tout effacer : écris EFFACER</span><span className="flex gap-2"><input className="field !w-32" value={wipe} onChange={(e) => setWipe(e.target.value)} aria-label="Confirmation d'effacement" /><button className="btn btn-danger" disabled={busy || wipe !== "EFFACER"} onClick={wipeAll}>Effacer</button></span></label>
          </div>
        </Section>
      )}

      {o?.isEmpty && (
        <Section title="Importer une situation de départ" hint="Colle un fichier JSON au format de seed/situation.exemple.json. Les informations absentes sont enregistrées comme manquantes.">
          <textarea className="field h-40 font-mono text-xs" value={situation} onChange={(e) => setSituation(e.target.value)} placeholder='{ "asOf": "2026-11-12", "profile": { … }, "accounts": [ … ] }' aria-label="Situation au format JSON" />
          <button className="btn btn-primary mt-3" disabled={busy || !situation.trim()} onClick={importSituation}>Importer</button>
        </Section>
      )}

      <Section title="Journal" hint="Chaque écriture est tracée, avec son auteur.">
        <ul className="max-h-72 divide-y divide-line/60 overflow-auto text-sm">
          {(data?.audit ?? []).map((a, i) => <li key={i} className="flex items-baseline justify-between gap-3 py-1.5"><span className="min-w-0 truncate"><span className="mr-2 rounded bg-surface-2 px-1.5 py-0.5 text-xs text-ink-2">{ACTORS[a.actor] ?? a.actor}</span>{a.detail}</span><span className="shrink-0 text-xs text-ink-3">{frDate(a.at)}</span></li>)}
        </ul>
      </Section>
    </Page>
  );
}
