import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessageParam, BetaTool, BetaToolResultBlockParam, BetaToolUnion, BetaToolUseBlock } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { z } from "zod";
import type { DB } from "@/lib/db/client";
import type { Block, ChatEvent, Step } from "./blocks";
import { buildContext, contextForModel } from "./context";
import { SYSTEM_PROMPT } from "./prompt";
import { TOOLS, executeTool } from "./tools";


const MAX_ITERATIONS = 12;
const HISTORY_LIMIT = 24;

export const isModelConfigured = (): boolean => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
export const modelName = (): string => process.env.ANTHROPIC_MODEL || "claude-opus-5-5";

function toolDefinitions(): BetaToolUnion[] {
  const tools: BetaToolUnion[] = TOOLS.map((t) => {
    const { $schema: _ignored, ...schema } = z.toJSONSchema(t.schema) as Record<string, unknown>;
    return { name: t.name, description: t.description, input_schema: schema as BetaTool["input_schema"], eager_input_streaming: true };
  });
  if (process.env.ENABLE_WEB_SEARCH === "true") {
    // Agent Recherche : recherche exécutée côté Anthropic, résultats cités avec leur source.
    tools.push({ type: "web_search_20260209", name: "web_search", max_uses: 5 });
  }
  return tools;
}

export interface OrchestratorResult {
  text: string;
  blocks: Block[];
  steps: Step[];
  engine: string;
}

/**
 * Boucle d'orchestration : le modèle choisit les spécialistes à solliciter, le serveur exécute
 * leurs calculs, le modèle synthétise. Les blocs visuels viennent des outils, jamais du modèle.
 */
export async function runModelOrchestrator(db: DB, history: { role: "user" | "assistant"; content: string }[], userMessage: string, emit: (event: ChatEvent) => void): Promise<OrchestratorResult> {
  const client = new Anthropic();
  const tools = toolDefinitions();
  const blocks: Block[] = [];
  const steps: Step[] = [];
  const sources = new Map<string, string>();
  let text = "";

  const messages: BetaMessageParam[] = [
    ...history.slice(-HISTORY_LIMIT).filter((m) => m.content.trim() !== "").map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: userMessage },
  ];

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const stream = client.beta.messages.stream({
      model: modelName(),
      max_tokens: 32000,
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: [
        { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
        // Recalculé à chaque tour : les outils de mémoire peuvent avoir modifié la situation.
        { type: "text", text: `# Situation actuelle\n\n${contextForModel(buildContext(db))}` },
      ],
      tools,
      messages,
    });
    stream.on("text", (delta) => {
      text += delta;
      emit({ type: "text", delta });
    });
    const message = await stream.finalMessage();

    for (const block of message.content) {
      if (block.type === "text") for (const c of block.citations ?? []) if (c.type === "web_search_result_location") sources.set(c.url, c.title ?? c.url);
      if (block.type === "server_tool_use" && block.name === "web_search") {
        const step: Step = { agent: "Recherche", label: "Recherche de sources actualisées" };
        steps.push(step);
        emit({ type: "step", step });
      }
    }

    if (message.stop_reason === "refusal") {
      const notice = "\n\nJe ne peux pas répondre à cette demande.";
      text += notice;
      emit({ type: "text", delta: notice });
      break;
    }
    if (message.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: message.content });
      continue;
    }
    if (message.stop_reason === "max_tokens") {
      const notice = "\n\n(Réponse interrompue : limite de longueur atteinte. Reformule ou découpe ta question.)";
      text += notice;
      emit({ type: "text", delta: notice });
      break;
    }

    const toolUses = message.content.filter((b): b is BetaToolUseBlock => b.type === "tool_use");
    if (toolUses.length === 0) break;

    messages.push({ role: "assistant", content: message.content });
    const results: BetaToolResultBlockParam[] = [];
    for (const use of toolUses) {
      const out = executeTool(use.name, use.input, db);
      const step: Step = { agent: out.agent, label: out.label };
      steps.push(step);
      emit({ type: "step", step });
      for (const b of out.blocks) {
        blocks.push(b);
        emit({ type: "block", block: b });
      }
      results.push({ type: "tool_result", tool_use_id: use.id, content: JSON.stringify(out.result), is_error: !out.ok });
    }
    messages.push({ role: "user", content: results });
    if (text !== "" && !text.endsWith("\n\n")) {
      text += "\n\n";
      emit({ type: "text", delta: "\n\n" });
    }
  }

  if (sources.size > 0) {
    const block: Block = { type: "sources", items: [...sources.entries()].map(([url, title]) => ({ url, title })) };
    blocks.push(block);
    emit({ type: "block", block });
  }
  return { text: text.trim(), blocks, steps, engine: modelName() };
}

/** Message d'erreur lisible, sans fuite de détail technique sensible. */
export function describeModelError(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) return "La clé API Anthropic est invalide. Vérifie ANTHROPIC_API_KEY.";
  if (error instanceof Anthropic.RateLimitError) return "Le service est momentanément saturé (limite de débit). Réessaie dans un instant.";
  if (error instanceof Anthropic.APIConnectionError) return "Impossible de joindre le service Anthropic. Vérifie la connexion réseau.";
  if (error instanceof Anthropic.APIError) return `Le service Anthropic a renvoyé une erreur (${error.status ?? "inconnue"}).`;
  return "Une erreur inattendue est survenue pendant l'analyse.";
}
