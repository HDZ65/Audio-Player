import { z } from "zod";
import { BankApiError, storeKeyFile } from "@/lib/connectors/enablebanking";
import { audit } from "@/lib/db/repo";
import { db, handle, json } from "@/lib/server";

/**
 * Dépose la clé privée de l'application dans secrets/ (hors du dépôt, lisible par le seul propriétaire).
 * La clé va du navigateur au serveur local ; elle n'est jamais renvoyée ni journalisée.
 */
export const POST = handle(async (request: Request) => {
  const { filename, pem } = z.object({ filename: z.string().min(5).max(200), pem: z.string().min(100).max(20_000) }).parse(await request.json());
  try {
    const { applicationId } = storeKeyFile(filename, pem);
    audit(db(), "utilisateur", "banque.cle", `Clé de l'application ${applicationId} enregistrée`);
    return json({ applicationId });
  } catch (error) {
    if (error instanceof BankApiError) return json({ error: error.message }, error.status);
    throw error;
  }
});
