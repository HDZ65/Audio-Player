import { z } from "zod";
import { createAccount, linkBankAccount, listAccounts, listBankAccounts } from "@/lib/db/repo";
import { db, handle, json } from "@/lib/server";

const schema = z.object({ id: z.number().int().positive(), accountId: z.number().int().positive().nullable().optional(), create: z.boolean().optional() });

/** Rattache un compte bancaire autorisé à un compte du patrimoine (ou en crée un). */
export const PATCH = handle(async (request: Request) => {
  const body = schema.parse(await request.json());
  const database = db();
  const link = listBankAccounts(database).find((l) => l.id === body.id);
  if (!link) return json({ error: "Compte bancaire inconnu" }, 404);
  let accountId = body.accountId ?? null;
  if (body.create) {
    accountId = createAccount(database, { name: `${link.label} ${link.ibanMasked ?? ""}`.trim(), kind: link.accountType === "SVGS" ? "livret" : "courant", balance: 0, source: "connexion bancaire" }).id;
  } else if (accountId !== null && !listAccounts(database).some((a) => a.id === accountId)) {
    return json({ error: "Compte du patrimoine inconnu" }, 404);
  }
  linkBankAccount(database, link.id, accountId);
  return json({ ok: true });
});
