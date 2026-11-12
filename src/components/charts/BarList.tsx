import { eur } from "@/lib/engine/money";

/** Barres horizontales : une seule série, donc pas de légende ; la valeur est écrite au bout de chaque barre. */
export function BarList({ items, unit }: { items: { label: string; value: number; hint?: string }[]; unit: "€" | "%" }) {
  const max = Math.max(...items.map((i) => Math.abs(i.value)), 1);
  const format = (v: number) => (unit === "€" ? eur(v) : `${v.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} %`);
  return (
    <ul className="space-y-2.5">
      {items.map((item) => (
        <li key={item.label} title={`${item.label} : ${format(item.value)}`}>
          <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate text-ink-2">{item.label}</span>
            <span className="tabular shrink-0 font-medium text-ink">{format(item.value)}</span>
          </div>
          <div className="h-3 w-full rounded-r bg-surface-2">
            <div className="h-3 rounded-r" style={{ width: `${Math.max(1.5, (Math.abs(item.value) / max) * 100)}%`, background: "var(--series-1)" }} />
          </div>
          {item.hint && <p className="mt-1 text-xs text-ink-3">{item.hint}</p>}
        </li>
      ))}
    </ul>
  );
}
