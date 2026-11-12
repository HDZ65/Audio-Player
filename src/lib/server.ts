import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { getDb, type DB } from "@/lib/db/client";
import { ensureSeeded } from "@/lib/db/seed";

const state = globalThis as unknown as { __seedChecked?: boolean };

/** Base prête à l'emploi : migrations appliquées, situation initiale chargée si disponible. */
export function db(): DB {
  const database = getDb();
  if (!state.__seedChecked) {
    state.__seedChecked = true;
    ensureSeeded(database);
  }
  return database;
}

export const json = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });

/** Enveloppe les routes : erreurs de validation lisibles, aucune trace technique renvoyée au client. */
export function handle<A extends unknown[]>(fn: (...args: A) => Promise<Response> | Response) {
  return async (...args: A): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (error) {
      if (error instanceof ZodError) return json({ error: "Données invalides", details: error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, 400);
      if (error instanceof SyntaxError) return json({ error: "Requête illisible" }, 400);
      console.error(error);
      return json({ error: "Erreur interne" }, 500);
    }
  };
}
