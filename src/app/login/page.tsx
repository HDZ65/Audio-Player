"use client";

import { useState } from "react";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const response = await fetch("/api/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
    if (response.ok) window.location.href = "/";
    else {
      setError(((await response.json().catch(() => ({}))) as { error?: string }).error ?? "Connexion impossible");
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <form onSubmit={submit} className="card w-full max-w-sm p-6">
        <h1 className="text-xl font-semibold tracking-tight">Mon IA financière</h1>
        <p className="mt-1 text-sm text-ink-2">Accès protégé.</p>
        <label className="mt-5 block"><span className="label">Mot de passe</span><input type="password" autoFocus autoComplete="current-password" required className="field" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        {error && <p className="mt-3 text-sm text-critical" role="alert">{error}</p>}
        <button className="btn btn-primary mt-5 w-full" disabled={busy}>Entrer</button>
      </form>
    </main>
  );
}
