import { configFromEnv, listBanks } from "@/lib/connectors/enablebanking";
import { handle, json } from "@/lib/server";

export const dynamic = "force-dynamic";

export const GET = handle(async (request: Request) => {
  const config = configFromEnv();
  if (!config) return json({ error: "Connexion bancaire non configurée" }, 400);
  const country = (new URL(request.url).searchParams.get("country") ?? "FR").toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) return json({ error: "Pays invalide" }, 400);
  const banks = await listBanks(config, country);
  return json(banks.map((b) => ({ name: b.name, country: b.country, maxConsentDays: Math.floor(b.maximum_consent_validity / 86_400), beta: Boolean(b.beta) })).sort((a, b) => a.name.localeCompare(b.name)));
});
