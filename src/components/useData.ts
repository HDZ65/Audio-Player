"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client";

/** Charge une ressource de l'API et expose un rechargement après modification. */
export function useData<T>(path: string): { data: T | null; error: string | null; reload: () => Promise<void> } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      setData(await api<T>(path));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Chargement impossible");
    }
  }, [path]);
  useEffect(() => { void reload(); }, [reload]);
  return { data, error, reload };
}

/** Exécute une écriture et remonte l'erreur éventuelle à l'écran. */
export function useAction(): { run: (fn: () => Promise<unknown>) => Promise<boolean>; error: string | null; busy: boolean } {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erreur");
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { run, error, busy };
}

export const toNumber = (raw: string): number | null => {
  const cleaned = raw.replace(/[\s  €]/g, "").replace(",", ".");
  if (cleaned === "" || !Number.isFinite(Number(cleaned))) return null;
  return Number(cleaned);
};
