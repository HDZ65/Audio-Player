"use client";

import { useEffect, useState } from "react";
import { Page, Section } from "@/components/AppShell";
import { useAction, useData } from "@/components/useData";
import { api, frDate } from "@/lib/client";
import { eur, eurCents } from "@/lib/engine/money";

interface BankAccount { id: number; label: string; ibanMasked: string | null; accountType: string; accountId: number | null }
interface Connection { id: number; aspspName: string; status: "active" | "expiree" | "erreur"; validUntil: string | null; lastSyncAt: string | null; lastError: string | null; accounts: BankAccount[] }
interface BankData {
  configured: boolean; redirectUrl: string;
  application: { name: string; environment: string; active: boolean; redirectRegistered: boolean } | null; applicationError: string | null;
  connections: Connection[]; localAccounts: { id: number; name: string; kind: string }[];
}
interface Bank { name: string; country: string; maxConsentDays: number; beta: boolean }
interface TrPreview { positions: { name: string; isin: string | null; shares: number; costBasis: number; assetClass: string }[]; stats: { rows: number; trades: number; cash: number; skipped: number; from: string | null; to: string | null; dividends: number; interest: number; fees: number; taxes: number }; warnings: string[] }

const STATUS: Record<Connection["status"], string> = { active: "Active", expiree: "Autorisation expirée", erreur: "Erreur" };
const TYPES: Record<string, string> = { CACC: "Compte courant", SVGS: "Épargne", CARD: "Carte", LOAN: "Prêt", CASH: "Espèces", OTHR: "Autre" };

function Banks({ data, reload }: { data: BankData; reload: () => void }) {
  const { run, error, busy } = useAction();
  const [banks, setBanks] = useState<Bank[] | null>(null);
  const [query, setQuery] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const outcome = new URLSearchParams(window.location.search).get("retour");
    if (outcome) {
      setMessage(outcome === "ok" ? "Banque connectée. Vérifie ci-dessous le rattachement de tes comptes." : outcome === "refus" ? "Autorisation annulée ou refusée côté banque. Rien n'a été connecté." : "La connexion a échoué. Réessaie dans un instant.");
      window.history.replaceState(null, "", "/connexions");
    }
  }, []);

  const loadBanks = () => run(async () => setBanks(await api<Bank[]>("/api/bank/banks?country=FR")));
  const connect = (bank: Bank) => run(async () => {
    const { url } = await api<{ url: string }>("/api/bank/connect", { method: "POST", body: { name: bank.name, country: bank.country } });
    window.location.href = url;
  });
  const sync = () => run(async () => {
    const { reports } = await api<{ reports: { connection: string; balancesUpdated: number; inserted: number; error?: string }[] }>("/api/bank/sync", { method: "POST", body: {} });
    setMessage(reports.length === 0 ? "Aucune connexion active à synchroniser." : reports.map((r) => r.error ? `${r.connection} : ${r.error}` : `${r.connection} : ${r.balancesUpdated} solde(s) mis à jour, ${r.inserted} nouvelle(s) opération(s)`).join(" · "));
    reload();
  });

  const filtered = (banks ?? []).filter((b) => b.name.toLowerCase().includes(query.toLowerCase()));

  return (
    <Section title="Banques — connexion en lecture seule" hint="Via Enable Banking, agrégateur agréé (DSP2). Tu t'identifies sur le site de ta banque : cette application ne voit jamais tes identifiants et ne peut ni virer ni payer."
      actions={data.connections.length > 0 ? <button className="btn btn-ghost" disabled={busy} onClick={sync}>Synchroniser maintenant</button> : undefined}>
      {message && <p className="mb-3 rounded-lg bg-surface-2 px-3 py-2 text-sm text-ink-2" role="status">{message}</p>}
      {error && <p className="mb-3 rounded-lg bg-critical-soft px-3 py-2 text-sm text-critical">{error}</p>}

      {!data.configured ? (
        <div className="text-sm text-ink-2">
          <p className="mb-2 font-medium text-ink">La connexion bancaire n'est pas encore configurée. Elle demande une inscription chez l'agrégateur, à faire une fois :</p>
          <ol className="list-decimal space-y-1.5 pl-5">
            <li>Crée un compte sur enablebanking.com, puis une application en environnement <strong className="text-ink">Production</strong>.</li>
            <li>Déclare cette adresse de retour, à l'identique : <code className="rounded bg-surface-2 px-1.5 py-0.5 text-xs text-ink">{data.redirectUrl}</code></li>
            <li>L'agrégateur n'accepte que des adresses <code className="rounded bg-surface-2 px-1 text-xs">https://</code> : en local, lance l'application avec <code className="rounded bg-surface-2 px-1 text-xs">npm run dev:https</code>.</li>
            <li>Garde le fichier <code className="rounded bg-surface-2 px-1 text-xs">.pem</code> téléchargé à la création : c'est la clé privée de l'application. Range-le dans <code className="rounded bg-surface-2 px-1 text-xs">secrets/</code> (ignoré par git).</li>
            <li>Active l'application en y déclarant tes propres comptes dans leur console : c'est le mode « restreint », réservé à tes comptes, sans contrat commercial. Vérifie à l'inscription qu'il est toujours gratuit.</li>
            <li>Renseigne <code className="rounded bg-surface-2 px-1 text-xs">ENABLE_BANKING_APP_ID</code> et <code className="rounded bg-surface-2 px-1 text-xs">ENABLE_BANKING_PRIVATE_KEY_PATH</code> dans <code className="rounded bg-surface-2 px-1 text-xs">.env.local</code>, puis redémarre.</li>
          </ol>
        </div>
      ) : (
        <>
          {data.applicationError && <p className="mb-3 rounded-lg bg-critical-soft px-3 py-2 text-sm text-critical">L'agrégateur ne reconnaît pas l'application : {data.applicationError}. Vérifie l'identifiant et la clé privée.</p>}
          {data.application && (!data.application.active || !data.application.redirectRegistered) && (
            <ul className="mb-3 list-disc space-y-1 rounded-lg bg-warning-soft py-2 pl-8 pr-3 text-sm">
              {!data.application.active && <li>L'application « {data.application.name} » n'est pas encore active chez Enable Banking : déclare tes propres comptes dans leur console pour l'activer.</li>}
              {!data.application.redirectRegistered && <li>L'adresse de retour <code className="text-xs">{data.redirectUrl}</code> n'est pas déclarée dans l'application : la banque refusera de revenir ici.</li>}
              {data.application.environment !== "PRODUCTION" && <li>Application en environnement de test : seules des banques fictives sont proposées.</li>}
            </ul>
          )}

          <ul className="space-y-3">
            {data.connections.map((c) => (
              <li key={c.id} className="rounded-xl border border-line p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h3 className="font-semibold">{c.aspspName} <span className={`ml-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${c.status === "active" ? "bg-surface-2 text-ink-2" : "bg-critical-soft text-critical"}`}>{STATUS[c.status]}</span></h3>
                    <p className="text-xs text-ink-3">Dernière synchronisation : {c.lastSyncAt ? frDate(c.lastSyncAt) : "jamais"} · autorisation valable jusqu'au {frDate(c.validUntil)}</p>
                    {c.lastError && <p className="mt-1 text-xs text-critical">{c.lastError}</p>}
                  </div>
                  <button className="btn btn-danger !py-1.5 text-xs" disabled={busy} onClick={async () => { if (confirm(`Déconnecter ${c.aspspName} ? L'autorisation est révoquée ; tes opérations déjà importées sont conservées.`) && await run(() => api(`/api/bank?id=${c.id}`, { method: "DELETE" }))) reload(); }}>Déconnecter</button>
                </div>
                <ul className="mt-3 divide-y divide-line/60 text-sm">
                  {c.accounts.map((a) => (
                    <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <span>{a.label} <span className="text-ink-3">{a.ibanMasked} · {TYPES[a.accountType] ?? a.accountType}</span></span>
                      <select aria-label={`Rattacher ${a.label}`} className="field !w-auto !py-1 text-xs" value={a.accountId ?? ""} onChange={async (e) => {
                        const v = e.target.value;
                        if (await run(() => api("/api/bank/accounts", { method: "PATCH", body: v === "new" ? { id: a.id, create: true } : { id: a.id, accountId: v ? Number(v) : null } }))) reload();
                      }}>
                        <option value="">Ne pas suivre ce compte</option>
                        {data.localAccounts.map((l) => <option key={l.id} value={l.id}>→ {l.name}</option>)}
                        <option value="new">Créer un nouveau compte</option>
                      </select>
                    </li>
                  ))}
                  {c.accounts.length === 0 && <li className="py-2 text-ink-3">La banque n'a partagé aucun compte.</li>}
                </ul>
                {c.status === "expiree" && <p className="mt-2 text-xs text-ink-2">Reconnecte cette banque ci-dessous pour renouveler l'autorisation ; tes rattachements seront conservés.</p>}
              </li>
            ))}
          </ul>

          <div className="mt-4 border-t border-line pt-4">
            {banks === null ? (
              <button className="btn btn-primary" disabled={busy} onClick={loadBanks}>{data.connections.length > 0 ? "Connecter une autre banque" : "Connecter une banque"}</button>
            ) : (
              <>
                <label><span className="label">Chercher ta banque ({banks.length} proposées en France)</span><input autoFocus className="field" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="BoursoBank, Trade Republic…" /></label>
                <ul className="mt-2 max-h-64 divide-y divide-line/60 overflow-auto rounded-lg border border-line">
                  {filtered.map((b) => (
                    <li key={b.name} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                      <span>{b.name} <span className="text-xs text-ink-3">autorisation jusqu'à {Math.min(180, b.maxConsentDays)} jours{b.beta ? " · en test" : ""}</span></span>
                      <button className="btn btn-ghost !py-1 text-xs" disabled={busy} onClick={() => connect(b)}>Connecter</button>
                    </li>
                  ))}
                  {filtered.length === 0 && <li className="px-3 py-3 text-sm text-ink-3">Aucune banque de ce nom chez l'agrégateur. Elle n'est peut-être pas couverte : utilise alors l'import de relevés.</li>}
                </ul>
              </>
            )}
          </div>
        </>
      )}
      <p className="mt-4 text-xs leading-relaxed text-ink-3">À savoir : la DSP2 couvre les comptes de paiement (compte courant, parfois les livrets). Les PEA, comptes-titres et assurances-vie ne sont généralement pas accessibles par cette voie. Les banques imposent de renouveler l'autorisation régulièrement, et limitent les lectures automatiques : la synchronisation se fait à l'ouverture de l'application, au plus deux fois par jour.</p>
    </Section>
  );
}

function TradeRepublic({ accounts, onDone }: { accounts: { id: number; name: string; kind: string }[]; onDone: () => void }) {
  const candidates = accounts.filter((a) => ["cto", "pea"].includes(a.kind));
  const { run, error, busy } = useAction();
  const [accountId, setAccountId] = useState("");
  const [text, setText] = useState<string | null>(null);
  const [preview, setPreview] = useState<TrPreview | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const choose = async (file: File | undefined) => {
    if (!file || !accountId) return;
    const content = await file.text();
    setDone(null);
    await run(async () => {
      setPreview(await api<TrPreview>("/api/import", { method: "POST", body: { type: "trade_republic", text: content, accountId: Number(accountId), preview: true } }));
      setText(content);
    });
  };
  const confirmImport = () => run(async () => {
    const r = await api<{ positions: number; inserted: number; duplicates: number; merged: string[] }>("/api/import", { method: "POST", body: { type: "trade_republic", text, accountId: Number(accountId) } });
    setDone(`${r.positions} position(s) enregistrée(s), ${r.inserted} mouvement(s) d'espèces ajouté(s), ${r.duplicates} déjà connu(s).${r.merged.length > 0 ? ` Lignes saisies à la main remplacées : ${r.merged.join(", ")}.` : ""} Renseigne maintenant la valeur actuelle de chaque ligne dans Patrimoine.`);
    setPreview(null);
    setText(null);
    onDone();
  });

  return (
    <Section title="Trade Republic — import de l'export officiel" hint="Trade Republic ne propose pas d'accès programmatique à ton portefeuille. La voie prévue par le courtier est l'export CSV : dans l'application, Profil → Relevés → Export des transactions, période « depuis le début ».">
      {error && <p className="mb-3 rounded-lg bg-critical-soft px-3 py-2 text-sm text-critical">{error}</p>}
      {done && <p className="mb-3 rounded-lg bg-surface-2 px-3 py-2 text-sm text-ink-2" role="status">{done}</p>}
      <div className="flex flex-wrap items-end gap-3">
        <label><span className="label">Compte Trade Republic dans ton patrimoine</span>
          <select className="field" value={accountId} onChange={(e) => { setAccountId(e.target.value); setPreview(null); }}>
            <option value="">Choisir…</option>
            {candidates.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        <label className={`btn btn-ghost ${accountId ? "cursor-pointer" : "cursor-not-allowed opacity-50"}`}>Choisir le fichier CSV<input type="file" accept=".csv,text/csv" disabled={!accountId || busy} className="sr-only" onChange={(e) => { void choose(e.target.files?.[0]); e.target.value = ""; }} /></label>
      </div>
      {candidates.length === 0 && <p className="mt-2 text-sm text-ink-3">Crée d'abord un compte-titres ou un PEA dans Patrimoine.</p>}

      {preview && (
        <div className="mt-4 border-t border-line pt-4">
          <p className="text-sm text-ink-2">Aperçu — rien n'est encore enregistré. {preview.stats.rows} lignes du {frDate(preview.stats.from)} au {frDate(preview.stats.to)} : {preview.stats.trades} achats ou ventes, {preview.stats.cash} mouvements d'espèces{preview.stats.skipped > 0 ? `, ${preview.stats.skipped} lignes ignorées` : ""}. Dividendes {eurCents(preview.stats.dividends)}, intérêts {eurCents(preview.stats.interest)}, frais {eurCents(preview.stats.fees)}, impôts prélevés {eurCents(preview.stats.taxes)}.</p>
          {preview.warnings.length > 0 && <ul className="mt-2 list-disc space-y-1 rounded-lg bg-warning-soft py-2 pl-8 pr-3 text-sm">{preview.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
          <div className="mt-3 max-h-72 overflow-auto">
            <table className="w-full min-w-[440px] text-sm">
              <thead className="sticky top-0 bg-surface"><tr className="border-b border-line text-left text-xs text-ink-3"><th className="py-1.5 font-medium">Titre</th><th className="font-medium">ISIN</th><th className="text-right font-medium">Quantité</th><th className="text-right font-medium">Prix de revient</th></tr></thead>
              <tbody className="tabular">{preview.positions.map((p) => <tr key={p.isin ?? p.name} className="border-b border-line/60"><td className="py-1.5">{p.name}</td><td className="text-ink-3">{p.isin ?? "—"}</td><td className="text-right">{p.shares.toLocaleString("fr-FR", { maximumFractionDigits: 6 })}</td><td className="text-right">{eur(p.costBasis)}</td></tr>)}</tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-ink-3">Le prix de revient est ce que tu as payé, pas ce que la ligne vaut aujourd'hui : l'export ne contient pas de cours. Les positions de ce compte importées précédemment seront remplacées ; les valeurs que tu as saisies sont conservées.</p>
          <div className="mt-3 flex gap-2"><button className="btn btn-primary" disabled={busy} onClick={confirmImport}>Enregistrer ces {preview.positions.length} positions</button><button className="btn btn-ghost" disabled={busy} onClick={() => { setPreview(null); setText(null); }}>Annuler</button></div>
        </div>
      )}
    </Section>
  );
}

export default function ConnexionsPage() {
  const { data, error, reload } = useData<BankData>("/api/bank");
  return (
    <Page title="Connexions" subtitle="Relie tes comptes par des voies autorisées. Tout est en lecture : l'application observe, elle n'agit jamais sur tes comptes.">
      {error && <p className="mb-4 rounded-lg bg-critical-soft px-3 py-2 text-sm text-critical">{error}</p>}
      {data && <Banks data={data} reload={() => void reload()} />}
      {data && <TradeRepublic accounts={data.localAccounts} onDone={() => void reload()} />}
      <Section title="Autres établissements" hint="Pour une banque non couverte par l'agrégateur, l'import d'un relevé CSV reste disponible depuis la page Budget.">
        <a href="/budget" className="btn btn-ghost">Importer un relevé CSV</a>
      </Section>
    </Page>
  );
}
