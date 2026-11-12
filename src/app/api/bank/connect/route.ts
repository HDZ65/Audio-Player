import { randomBytes } from "node:crypto";
import { z } from "zod";
import { BankApiError, configFromEnv, listBanks, startAuthorization } from "@/lib/connectors/enablebanking";
import { createPendingConnection } from "@/lib/db/repo";
import { db, handle, json } from "@/lib/server";

const MAX_CONSENT_DAYS = 180;

/** Démarre l'autorisation : renvoie l'adresse de la banque, où l'utilisateur s'identifie lui-même. */
export const POST = handle(async (request: Request) => {
  const config = configFromEnv();
  if (!config) return json({ error: "Connexion bancaire non configurée" }, 400);
  const { name, country } = z.object({ name: z.string().min(1).max(120), country: z.string().regex(/^[A-Z]{2}$/) }).parse(await request.json());
  try {
    const bank = (await listBanks(config, country)).find((b) => b.name === name);
    if (!bank) return json({ error: "Banque non proposée par l'agrégateur" }, 404);
    const days = Math.max(1, Math.min(MAX_CONSENT_DAYS, Math.floor(bank.maximum_consent_validity / 86_400)));
    const validUntil = new Date(Date.now() + days * 86_400_000 - 60_000).toISOString();
    const state = randomBytes(32).toString("hex");
    createPendingConnection(db(), { provider: "enablebanking", aspspName: name, aspspCountry: country, state, validUntil });
    const { url } = await startAuthorization(config, { name, country, state, validUntil });
    return json({ url });
  } catch (error) {
    if (error instanceof BankApiError) return json({ error: `L'agrégateur a refusé la demande : ${error.message}` }, 502);
    throw error;
  }
});
