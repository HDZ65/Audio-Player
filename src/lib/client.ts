/** Appels à l'API interne depuis le navigateur. */
export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const response = await fetch(path, {
    method: init?.method ?? "GET",
    headers: init?.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });
  if (response.status === 401) {
    window.location.href = "/login";
    throw new Error("Authentification requise");
  }
  const data = (await response.json().catch(() => ({}))) as { error?: string; details?: string[] };
  if (!response.ok) throw new Error([data.error ?? "Erreur", ...(data.details ?? [])].join(" — "));
  return data as T;
}

export const frDate = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
};

export const KIND_LABELS: Record<string, string> = {
  courant: "Compte courant", livret: "Livret d'épargne", pea: "PEA", cto: "Compte-titres", assurance_vie: "Assurance-vie", credit: "Crédit", immobilier: "Immobilier", autre: "Autre",
};
export const ASSET_LABELS: Record<string, string> = { action: "Action", etf: "ETF", obligation: "Obligation", fonds: "Fonds", crypto: "Crypto-actif", autre: "Autre" };
export const STATUS_LABELS: Record<string, string> = { verifie: "Vérifié", estime: "Estimation", manquant: "Manquant" };
