import { z } from "zod";
import type { ChatEvent } from "@/lib/ai/blocks";
import { runLocalOrchestrator } from "@/lib/ai/local";
import { describeModelError, isModelConfigured, runModelOrchestrator } from "@/lib/ai/orchestrator";
import { addMessage, currentConversationId, listMessages, newConversation } from "@/lib/db/repo";
import { db, handle, json } from "@/lib/server";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const bodySchema = z.object({ message: z.string().trim().min(1).max(4000) });

export const POST = handle(async (request: Request) => {
  const { message } = bodySchema.parse(await request.json());
  const database = db();
  const conversationId = currentConversationId(database);
  const history = listMessages(database, conversationId).map((m) => ({ role: m.role, content: m.content }));
  addMessage(database, conversationId, "user", message);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: ChatEvent) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      try {
        let result;
        if (isModelConfigured()) {
          try {
            result = await runModelOrchestrator(database, history, message, emit);
          } catch (error) {
            console.error(error);
            // Secours : le mode local répond avec les mêmes calculs, en le disant clairement.
            const notice = `_${describeModelError(error)} Je réponds en mode local._\n\n`;
            emit({ type: "text", delta: notice });
            const local = await runLocalOrchestrator(database, message, emit);
            result = { ...local, text: notice + local.text };
          }
        } else {
          result = await runLocalOrchestrator(database, message, emit);
        }
        addMessage(database, conversationId, "assistant", result.text, result.blocks, result.steps, result.engine);
        emit({ type: "done", engine: result.engine });
      } catch (error) {
        console.error(error);
        emit({ type: "error", message: "L'analyse a échoué. Réessaie." });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
});

/** Démarre une nouvelle conversation ; la mémoire financière, elle, est conservée. */
export const DELETE = handle(async () => {
  newConversation(db());
  return json({ ok: true });
});
