import { configFromEnv } from "@/lib/connectors/enablebanking";
import { completeAuthorization, syncConnection } from "@/lib/connectors/sync";
import { db } from "@/lib/server";

export const dynamic = "force-dynamic";

/**
 * Retour de la banque. La réponse est une page relais plutôt qu'une redirection HTTP : la navigation
 * suivante part ainsi de l'application elle-même, et le cookie de session y est de nouveau joint.
 */
const relay = (outcome: "ok" | "refus" | "erreur"): Response =>
  new Response(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=/connexions?retour=${outcome}"><title>Retour de la banque</title></head><body><p>Retour vers l'application… <a href="/connexions?retour=${outcome}">Continuer</a></p></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const state = params.get("state");
  const code = params.get("code");
  const config = configFromEnv();
  if (params.get("error") || !code) return relay("refus");
  if (!config || !state || !/^[0-9a-f]{64}$/.test(state)) return relay("erreur");
  try {
    const database = db();
    const connection = await completeAuthorization(database, config, state, code);
    await syncConnection(database, config, connection.id);
    return relay("ok");
  } catch (error) {
    console.error(error);
    return relay("erreur");
  }
}
