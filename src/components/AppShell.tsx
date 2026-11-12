"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV = [
  { href: "/", label: "Assistant", icon: "M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 4v-4A2.5 2.5 0 0 1 4 13.5z" },
  { href: "/patrimoine", label: "Patrimoine", icon: "M3 20h18M5 20V10m4.7 10V10m4.6 10V10M19 20V10M2.5 10 12 3.5 21.5 10z" },
  { href: "/budget", label: "Budget", icon: "M3 7.5A2.5 2.5 0 0 1 5.5 5h13A2.5 2.5 0 0 1 21 7.5v9a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5zM3 10h18M7 15h3" },
  { href: "/objectifs", label: "Objectifs", icon: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zm0-4a5 5 0 1 0 0-10 5 5 0 0 0 0 10zm0-4a1 1 0 1 0 0-2 1 1 0 0 0 0 2z" },
  { href: "/simulateurs", label: "Simulateurs", icon: "M4 19V5m0 14h16M8 15l3.5-4 3 2.5L20 7" },
  { href: "/memoire", label: "Mémoire", icon: "M5 4.5A1.5 1.5 0 0 1 6.5 3H17a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6.5A1.5 1.5 0 0 1 5 19.5zM9 8h6M9 12h6M9 16h3" },
];

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

/** L'assistant est l'écran principal ; les modules de gestion vivent dans une navigation secondaire, discrète. */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (pathname === "/login") return <>{children}</>;
  const active = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));

  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <nav aria-label="Navigation" className="sticky top-0 hidden h-dvh w-[76px] shrink-0 flex-col items-center gap-1 border-r border-line bg-surface py-4 md:flex">
        <Link href="/" aria-label="Accueil" className="mb-4 flex h-9 w-9 items-center justify-center rounded-xl bg-accent text-on-accent">
          <Icon d="M5 16l5-5 3.5 3.5L20 8" />
        </Link>
        {NAV.map((item) => (
          <Link key={item.href} href={item.href} aria-current={active(item.href) ? "page" : undefined}
            className={`flex w-[64px] flex-col items-center gap-1 rounded-xl py-2 text-[10.5px] font-medium transition ${active(item.href) ? "bg-accent-soft text-accent" : "text-ink-3 hover:bg-surface-2 hover:text-ink"}`}>
            <Icon d={item.icon} />
            {item.label}
          </Link>
        ))}
      </nav>
      <main className="min-w-0 flex-1 pb-[calc(64px+env(safe-area-inset-bottom))] md:pb-0">{children}</main>
      <nav aria-label="Navigation" className="fixed inset-x-0 bottom-0 z-20 flex justify-around border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
        {NAV.map((item) => (
          <Link key={item.href} href={item.href} aria-current={active(item.href) ? "page" : undefined}
            className={`flex min-w-0 flex-1 flex-col items-center gap-0.5 py-2 text-[10px] font-medium ${active(item.href) ? "text-accent" : "text-ink-3"}`}>
            <Icon d={item.icon} />
            <span className="max-w-full truncate px-0.5">{item.label}</span>
          </Link>
        ))}
      </nav>
    </div>
  );
}

export function Page({ title, subtitle, actions, children }: { title: string; subtitle?: string; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-8">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-1 max-w-2xl text-sm text-ink-2">{subtitle}</p>}
        </div>
        {actions}
      </header>
      {children}
    </div>
  );
}

export function Section({ title, hint, children, actions }: { title: string; hint?: string; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <section className="card mb-5 p-4 sm:p-5">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">{title}</h2>
          {hint && <p className="mt-0.5 text-xs text-ink-3">{hint}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}
