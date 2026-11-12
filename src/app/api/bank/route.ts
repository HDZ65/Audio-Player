import { configFromEnv, getApplication, redirectUrl } from "@/lib/connectors/enablebanking";
import { disconnect } from "@/lib/connectors/sync";
import { listAccounts, listBankAccounts, listConnections } from "@/lib/db/repo";
import { db, handle, json } from "@/lib/server";

export const dynamic = "force-dynamic";

export const GET = handle(async () => {
  const database = db();
  const config = configFromEnv();
  let application: { name: string; environment: string; active: boolean; redirectRegistered: boolean } | null = null;
  let applicationError: string | null = null;
  if (config) {
    try {
      const app = await getApplication(config);
      application = { name: app.name, environment: app.environment, active: app.active, redirectRegistered: app.redirect_urls.includes(redirectUrl()) };
    } catch (error) {
      applicationError = error instanceof Error ? error.message : "Service injoignable";
    }
  }
  return json({
    configured: config !== null,
    redirectUrl: redirectUrl(),
    application,
    applicationError,
    // L'identifiant de session n'est jamais renvoyé au navigateur.
    connections: listConnections(database).map(({ sessionId: _s, state: _t, ...c }) => ({ ...c, accounts: listBankAccounts(database, c.id) })),
    localAccounts: listAccounts(database).map((a) => ({ id: a.id, name: a.name, kind: a.kind })),
  });
});

export const DELETE = handle(async (request: Request) => {
  const id = Number(new URL(request.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) return json({ error: "Connexion inconnue" }, 400);
  await disconnect(db(), configFromEnv(), id);
  return json({ ok: true });
});
