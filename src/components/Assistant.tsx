"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { BlockView } from "@/components/blocks/BlockView";
import { Markdown } from "@/components/Markdown";
import type { Block, ChatEvent, Step } from "@/lib/ai/blocks";
import { api, frDate } from "@/lib/client";
import { eur } from "@/lib/engine/money";

interface Insight { key: string; agent: string; severity: "critique" | "important" | "info"; nature: string; title: string; detail: string; prompt: string | null; alertId: number | null }
interface Overview {
  isEmpty: boolean; date: string; asOf: string | null;
  netWorth: { total: number; liquid: number; invested: number };
  insights: Insight[]; missing: string[];
  messages: { id: number; role: "user" | "assistant"; content: string; blocks: Block[]; steps: Step[]; engine: string | null }[];
  engine: { kind: "modele" | "local"; name: string; webSearch: boolean };
  authEnabled: boolean;
}
interface Message { id: string; role: "user" | "assistant"; content: string; blocks: Block[]; steps: Step[]; pending?: boolean; error?: string }

const SUGGESTIONS = [
  "J'ai 1 000 € disponibles. Qu'est-ce que tu me conseilles d'en faire ?",
  "Si j'investis 600 € par mois, combien pourrais-je avoir dans 10 ans ?",
  "Si je perds mon emploi pendant six mois, combien de temps puis-je tenir ?",
  "Quelle stratégie pour atteindre 100 000 € de patrimoine le plus rapidement ?",
];

const NATURE_LABELS: Record<string, string> = { fait: "Fait", estimation: "Estimation", donnee_manquante: "Donnée manquante", hypothese: "Hypothèse" };
const greeting = (): string => { const h = new Date().getHours(); return h < 5 || h >= 18 ? "Bonsoir" : "Bonjour"; };

function Steps({ steps, pending }: { steps: Step[]; pending?: boolean }) {
  if (steps.length === 0) return null;
  const unique = steps.filter((s, i) => steps.findIndex((x) => x.agent === s.agent && x.label === s.label) === i);
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Spécialistes sollicités">
      {unique.map((s, i) => (
        <li key={`${s.agent}-${s.label}`} className="rounded-full bg-surface-2 px-2.5 py-1 text-[11px] text-ink-2">
          <span className="font-semibold text-ink">Agent {s.agent}</span> · {s.label}{pending && i === unique.length - 1 ? "…" : ""}
        </li>
      ))}
    </ul>
  );
}

export function Assistant() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async (withMessages: boolean) => {
    try {
      const data = await api<Overview>("/api/overview");
      setOverview(data);
      if (withMessages) setMessages(data.messages.map((m) => ({ id: String(m.id), role: m.role, content: m.content, blocks: m.blocks, steps: m.steps })));
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Chargement impossible");
    }
  }, []);
  useEffect(() => { void load(true); }, [load]);

  const scrollToEnd = () => requestAnimationFrame(() => endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }));

  const send = async (text: string) => {
    const message = text.trim();
    if (!message || busy) return;
    setBusy(true);
    setInput("");
    const replyId = `r-${Date.now()}`;
    setMessages((prev) => [...prev, { id: `u-${Date.now()}`, role: "user", content: message, blocks: [], steps: [] }, { id: replyId, role: "assistant", content: "", blocks: [], steps: [], pending: true }]);
    scrollToEnd();
    const patch = (fn: (m: Message) => Message) => setMessages((prev) => prev.map((m) => (m.id === replyId ? fn(m) : m)));

    try {
      const response = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message }) });
      if (!response.ok || !response.body) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? "L'assistant est indisponible.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as ChatEvent;
          if (event.type === "text") patch((m) => ({ ...m, content: m.content + event.delta }));
          else if (event.type === "step") patch((m) => ({ ...m, steps: [...m.steps, event.step] }));
          else if (event.type === "block") patch((m) => ({ ...m, blocks: [...m.blocks, event.block] }));
          else if (event.type === "error") patch((m) => ({ ...m, error: event.message }));
        }
        scrollToEnd();
      }
    } catch (e) {
      patch((m) => ({ ...m, error: e instanceof Error ? e.message : "Erreur" }));
    } finally {
      patch((m) => ({ ...m, pending: false }));
      setBusy(false);
      void load(false);
      inputRef.current?.focus();
    }
  };

  const reset = async () => {
    await api("/api/chat", { method: "DELETE" });
    setMessages([]);
  };
  const dismiss = async (insight: Insight) => {
    if (insight.alertId === null) return;
    await api(`/api/data/alerts?id=${insight.alertId}`, { method: "DELETE" });
    void load(false);
  };
  const usePrompt = (prompt: string) => {
    if (prompt.includes("…")) {
      setInput(prompt);
      inputRef.current?.focus();
    } else void send(prompt);
  };

  if (loadError) return <div className="mx-auto max-w-3xl px-4 py-16 text-center text-sm text-critical">{loadError}</div>;
  if (!overview) return <div className="mx-auto max-w-3xl px-4 py-16 text-center text-sm text-ink-3">Chargement de ta situation…</div>;

  const nw = overview.netWorth;
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col px-4 sm:px-6">
      <header className="pt-8 sm:pt-12">
        <div className="flex items-start justify-between gap-3">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{greeting()}{overview.isEmpty ? "." : ", voici ta situation financière."}</h1>
          {messages.length > 0 && <button onClick={reset} disabled={busy} className="btn btn-ghost shrink-0 !px-2.5 !py-1.5 text-xs">Nouvelle conversation</button>}
        </div>

        {overview.isEmpty ? (
          <div className="card mt-6 p-5">
            <p className="text-sm text-ink-2">Je ne connais pas encore ta situation. Pour que mes analyses partent de tes vrais chiffres, commence par renseigner tes comptes et tes revenus.</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Link href="/patrimoine" className="btn btn-primary">Saisir mes comptes</Link>
              <Link href="/memoire" className="btn btn-ghost">Importer une situation de départ</Link>
            </div>
          </div>
        ) : (
          <>
            <dl className="mt-6 grid grid-cols-3 gap-3">
              {[{ label: "Patrimoine", value: nw.total }, { label: "Épargne disponible", value: nw.liquid }, { label: "Placements", value: nw.invested }].map((k) => (
                <div key={k.label} className="card px-3 py-3 sm:px-4">
                  <dt className="text-[11px] leading-tight text-ink-3 sm:text-xs">{k.label}</dt>
                  <dd className="tabular mt-1 text-lg font-semibold tracking-tight sm:text-2xl">{eur(k.value)}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-2 text-xs text-ink-3">Soldes saisis, photographie au {frDate(overview.asOf)} — pas des données en temps réel.</p>

            {messages.length === 0 && overview.insights.length > 0 && (
              <ul className="mt-6 space-y-2.5">
                {overview.insights.map((insight) => (
                  <li key={insight.key} className="card p-4">
                    <div className="flex items-start justify-between gap-3">
                      <p className="text-[15px] font-medium leading-snug">{insight.severity === "critique" && <span className="mr-1.5 rounded bg-critical-soft px-1.5 py-0.5 text-[11px] font-semibold text-critical">Urgent</span>}{insight.title}</p>
                      {insight.alertId !== null && <button onClick={() => dismiss(insight)} aria-label="Ignorer cette alerte" title="Ignorer" className="-mr-1 -mt-1 shrink-0 rounded-md p-1 text-ink-3 hover:bg-surface-2 hover:text-ink">✕</button>}
                    </div>
                    <p className="mt-1 text-sm leading-relaxed text-ink-2">{insight.detail}</p>
                    <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
                      <span className="text-[11px] text-ink-3">Agent {insight.agent} · {NATURE_LABELS[insight.nature] ?? insight.nature}</span>
                      {insight.prompt && <button onClick={() => usePrompt(insight.prompt!)} disabled={busy} className="text-left text-xs font-medium text-accent underline-offset-2 hover:underline">{insight.prompt} →</button>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        {messages.length === 0 && !overview.isEmpty && (
          <div className="mt-6">
            <p className="mb-2 text-xs font-medium text-ink-3">Tu peux aussi me demander</p>
            <div className="flex flex-wrap gap-2">
              {SUGGESTIONS.map((s) => <button key={s} onClick={() => send(s)} disabled={busy} className="rounded-full border border-line bg-surface px-3 py-1.5 text-left text-xs text-ink-2 transition hover:border-accent hover:text-ink">{s}</button>)}
            </div>
          </div>
        )}
      </header>

      <div className="flex-1 space-y-6 py-6" aria-live="polite">
        {messages.map((m) => m.role === "user" ? (
          <div key={m.id} className="flex justify-end"><p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-[15px] leading-relaxed text-on-accent">{m.content}</p></div>
        ) : (
          <article key={m.id} className="space-y-3">
            <Steps steps={m.steps} pending={m.pending} />
            {m.blocks.map((b, i) => <BlockView key={i} block={b} />)}
            {m.content && <Markdown text={m.content} />}
            {m.pending && !m.content && <p className="typing text-2xl leading-none text-ink-3" aria-label="Analyse en cours"><span>•</span><span>•</span><span>•</span></p>}
            {m.error && <p className="rounded-lg bg-critical-soft px-3 py-2 text-sm text-critical">{m.error}</p>}
          </article>
        ))}
        <div ref={endRef} />
      </div>

      <div className="sticky bottom-[calc(64px+env(safe-area-inset-bottom))] -mx-4 bg-gradient-to-t from-bg via-bg to-transparent px-4 pb-4 pt-6 sm:-mx-6 sm:px-6 md:bottom-0">
        <form onSubmit={(e) => { e.preventDefault(); void send(input); }} className="card flex items-end gap-2 p-2 shadow-sm focus-within:border-accent">
          <label htmlFor="question" className="sr-only">Que souhaites-tu analyser ?</label>
          <textarea id="question" ref={inputRef} value={input} rows={1} maxLength={4000} placeholder="Que souhaites-tu analyser ?" disabled={busy}
            onChange={(e) => { setInput(e.target.value); e.target.style.height = "auto"; e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`; }}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(input); } }}
            className="max-h-40 min-h-[40px] flex-1 resize-none bg-transparent px-2 py-2 text-[15px] outline-none placeholder:text-ink-3" />
          <button type="submit" disabled={busy || !input.trim()} aria-label="Envoyer" className="btn btn-primary h-10 w-10 !p-0">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6" /></svg>
          </button>
        </form>
        <p className="mt-2 text-center text-[11px] leading-snug text-ink-3">
          {overview.engine.kind === "modele" ? `Analyses rédigées par ${overview.engine.name}` : "Mode local : réponses par règles, sans modèle d'IA"} · calculs par un moteur déterministe testé · analyse informative, pas un conseil en investissement réglementé.
        </p>
      </div>
    </div>
  );
}
