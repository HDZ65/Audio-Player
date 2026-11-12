"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { eur } from "@/lib/engine/money";

export interface LineSeries {
  name: string;
  color: string;
  dashed?: boolean;
  points: { x: number; y: number }[];
}

const compact = (n: number): string => {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} M€`;
  if (abs >= 10_000) return `${Math.round(n / 1000)} k€`;
  return `${Math.round(n).toLocaleString("fr-FR")} €`;
};

function niceTicks(min: number, max: number, count = 4): number[] {
  if (max === min) return [min];
  const raw = (max - min) / count;
  const magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? raw;
  const start = Math.floor(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max + step * 0.01; v += step) ticks.push(Math.round(v * 100) / 100);
  return ticks;
}

/** Courbes avec légende, étiquettes de fin, repère vertical et infobulle au survol ou au toucher. */
export function LineChart({ series, xLabel, height = 260 }: { series: LineSeries[]; xLabel: string; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => entry && setWidth(Math.max(260, entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const geometry = useMemo(() => {
    const all = series.flatMap((s) => s.points);
    const xs = [...new Set(all.map((p) => p.x))].sort((a, b) => a - b);
    const yMinRaw = Math.min(0, ...all.map((p) => p.y));
    const yMaxRaw = Math.max(...all.map((p) => p.y), 1);
    const ticks = niceTicks(yMinRaw, yMaxRaw);
    const yMin = Math.min(yMinRaw, ticks[0] ?? 0);
    const yMax = Math.max(yMaxRaw, ticks[ticks.length - 1] ?? yMaxRaw);
    const endLabels = width >= 520;
    const margin = { top: 12, right: endLabels ? 86 : 14, bottom: 34, left: 52 };
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;
    const xMin = xs[0] ?? 0;
    const xMax = xs[xs.length - 1] ?? 1;
    const sx = (x: number) => margin.left + (xMax === xMin ? 0 : ((x - xMin) / (xMax - xMin)) * innerW);
    const sy = (y: number) => margin.top + innerH - ((y - yMin) / (yMax - yMin || 1)) * innerH;
    return { xs, ticks, margin, innerW, innerH, sx, sy, endLabels };
  }, [series, width, height]);

  const { xs, ticks, margin, innerW, innerH, sx, sy, endLabels } = geometry;
  const xTickEvery = Math.max(1, Math.ceil(xs.length / (width < 420 ? 5 : 9)));

  // Étiquettes de fin : écartées verticalement pour ne jamais se chevaucher.
  const ends = series
    .map((s) => ({ s, last: s.points[s.points.length - 1] }))
    .filter((e): e is { s: LineSeries; last: { x: number; y: number } } => Boolean(e.last))
    .map((e) => ({ ...e, y: sy(e.last.y) }))
    .sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i]!.y - ends[i - 1]!.y < 15) ends[i]!.y = ends[i - 1]!.y + 15;

  const onMove = (clientX: number, rect: DOMRect) => {
    const x = clientX - rect.left;
    let best = 0;
    let bestDistance = Infinity;
    xs.forEach((value, i) => {
      const distance = Math.abs(sx(value) - x);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    });
    setHover(best);
  };

  const hoverX = hover !== null ? xs[hover] : undefined;
  const tooltipLeft = hoverX !== undefined ? Math.min(Math.max(sx(hoverX) + 12, 4), width - 190) : 0;

  return (
    <div ref={ref} className="relative w-full select-none">
      <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
        {series.map((s) => (
          <li key={s.name} className="flex items-center gap-1.5">
            <svg width="18" height="8" aria-hidden="true"><line x1="1" y1="4" x2="17" y2="4" stroke={s.color} strokeWidth="2.5" strokeLinecap="round" strokeDasharray={s.dashed ? "4 4" : undefined} /></svg>
            {s.name}
          </li>
        ))}
      </ul>
      <svg width={width} height={height} role="img" aria-label={`Graphique : ${series.map((s) => s.name).join(", ")}`}
        onMouseMove={(e) => onMove(e.clientX, e.currentTarget.getBoundingClientRect())} onMouseLeave={() => setHover(null)}
        onTouchStart={(e) => e.touches[0] && onMove(e.touches[0].clientX, e.currentTarget.getBoundingClientRect())}
        onTouchMove={(e) => e.touches[0] && onMove(e.touches[0].clientX, e.currentTarget.getBoundingClientRect())}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={margin.left} x2={margin.left + innerW} y1={sy(t)} y2={sy(t)} stroke="var(--grid)" strokeWidth="1" />
            <text x={margin.left - 8} y={sy(t)} textAnchor="end" dominantBaseline="middle" fontSize="11" fill="var(--text-3)" className="tabular">{compact(t)}</text>
          </g>
        ))}
        {xs.map((x, i) => (i % xTickEvery === 0 || i === xs.length - 1) && (
          <text key={x} x={sx(x)} y={margin.top + innerH + 16} textAnchor="middle" fontSize="11" fill="var(--text-3)" className="tabular">{x}</text>
        ))}
        <text x={margin.left + innerW / 2} y={height - 2} textAnchor="middle" fontSize="11" fill="var(--text-3)">{xLabel}</text>
        {hoverX !== undefined && <line x1={sx(hoverX)} x2={sx(hoverX)} y1={margin.top} y2={margin.top + innerH} stroke="var(--text-3)" strokeWidth="1" />}
        {series.map((s) => (
          <path key={s.name} d={s.points.map((p, i) => `${i === 0 ? "M" : "L"}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(" ")} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" strokeDasharray={s.dashed ? "5 5" : undefined} />
        ))}
        {ends.map(({ s, last, y }) => (
          <g key={s.name}>
            <circle cx={sx(last.x)} cy={sy(last.y)} r="4" fill={s.color} stroke="var(--surface)" strokeWidth="2" />
            {endLabels && <text x={sx(last.x) + 9} y={y} dominantBaseline="middle" fontSize="11" fontWeight="600" fill="var(--text)" className="tabular">{compact(last.y)}</text>}
          </g>
        ))}
        {hoverX !== undefined && series.map((s) => {
          const p = s.points.find((q) => q.x === hoverX);
          return p ? <circle key={s.name} cx={sx(p.x)} cy={sy(p.y)} r="4.5" fill={s.color} stroke="var(--surface)" strokeWidth="2" /> : null;
        })}
      </svg>
      {hoverX !== undefined && (
        <div className="pointer-events-none absolute top-8 z-10 w-[180px] rounded-lg border border-line bg-surface p-2 text-xs shadow-lg" style={{ left: tooltipLeft }}>
          <div className="mb-1 font-medium text-ink">{xLabel} : {hoverX}</div>
          {series.map((s) => {
            const p = s.points.find((q) => q.x === hoverX);
            return p ? (
              <div key={s.name} className="flex items-center justify-between gap-2 text-ink-2">
                <span className="flex min-w-0 items-center gap-1.5"><span className="h-2 w-2 shrink-0 rounded-full" style={{ background: s.color }} /><span className="truncate">{s.name}</span></span>
                <span className="tabular font-medium text-ink">{eur(p.y)}</span>
              </div>
            ) : null;
          })}
        </div>
      )}
    </div>
  );
}
