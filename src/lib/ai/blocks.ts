/**
 * Blocs riches affichés dans la conversation. Ils sont produits par les outils déterministes
 * (jamais rédigés par le modèle) : les chiffres affichés sont donc toujours ceux du moteur.
 */
import type { ScenarioName } from "@/lib/engine";

export type AgentName = "Patrimoine" | "Budget" | "Bourse" | "Immobilier" | "Fiscalité" | "Recherche" | "Stratégie";

export interface Step {
  agent: AgentName;
  label: string;
}

export type Block =
  | { type: "kpis"; title?: string; items: { label: string; value: string; hint?: string }[] }
  | {
      type: "projection";
      title: string;
      params: { initial: number; monthly: number; years: number; wrapper: "PEA" | "CTO" | "LIVRET"; wrapperAgeYears: number };
      monteCarlo?: { p10: number; p50: number; p90: number; probabilityOfLoss: number; medianMaxDrawdown: number; paths: number };
    }
  | { type: "options"; title: string; options: { title: string; recommended: boolean; split: { label: string; amount: number }[]; range: { low: number; central: number; high: number }; pros: string[]; cons: string[] }[] }
  | { type: "table"; title: string; columns: string[]; rows: (string | number)[][]; note?: string }
  | { type: "lines"; title: string; unit: "€"; xLabel: string; series: { name: string; points: { x: number; y: number }[] }[]; note?: string }
  | { type: "bars"; title: string; unit: "€" | "%"; items: { label: string; value: number; hint?: string }[]; note?: string }
  | { type: "scenarios"; title: string; columns: [string, string]; rows: { scenario: ScenarioName; a: number; b: number; verdict: string }[]; note?: string }
  | { type: "plan"; title: string; steps: { title: string; detail: string }[] }
  | { type: "notice"; tone: "info" | "attention"; title: string; items: string[] }
  | { type: "memory"; items: string[] }
  | { type: "action"; actionId: number; title: string; params: { label: string; value: string }[]; status: "preparee" | "confirmee" | "annulee" }
  | { type: "sources"; items: { title: string; url: string }[] };

export type ChatEvent =
  | { type: "step"; step: Step }
  | { type: "text"; delta: string }
  | { type: "block"; block: Block }
  | { type: "done"; engine: string }
  | { type: "error"; message: string };
