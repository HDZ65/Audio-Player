/**
 * Import de l'export CSV natif de Trade Republic (application : Profil → Relevés → Export des transactions).
 *
 * Trade Republic ne propose pas d'API publique. Les bibliothèques non officielles qui imitent
 * l'application mobile contournent ses mécanismes de sécurité : elles ne sont pas utilisées ici.
 * L'export CSV est la voie prévue par le courtier ; il contient tout l'historique.
 *
 * Les positions sont reconstituées à partir des achats et des ventes : quantités et prix de revient
 * sont exacts, mais AUCUNE valeur de marché n'est déduite — l'export ne contient pas de cours actuels.
 */
import { categorize } from "@/lib/budget/categorize";
import type { DB } from "@/lib/db/client";
import * as repo from "@/lib/db/repo";
import type { TransactionInput } from "@/lib/db/repo";
import type { AssetClass } from "@/lib/engine";

export const TR_SOURCE = "Trade Republic (export CSV)";

function splitLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === delimiter && !quoted) {
      out.push(current);
      current = "";
    } else current += c;
  }
  out.push(current);
  return out.map((s) => s.trim());
}

/** Nombre au format international ou européen ; le dernier séparateur rencontré est la décimale. */
export function parseNumber(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  let s = raw.replace(/[\s  €$]/g, "");
  if (s === "") return null;
  const comma = s.lastIndexOf(",");
  const dot = s.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) s = comma > dot ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  else if (comma >= 0) s = s.replace(",", ".");
  return /^[-+]?\d*\.?\d+(e[-+]?\d+)?$/i.test(s) ? Number(s) : null;
}

const norm = (s: string): string => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");

export interface TrPosition {
  isin: string | null;
  name: string;
  assetClass: AssetClass;
  shares: number;
  /** Prix de revient des titres encore détenus (méthode du prix moyen pondéré, frais inclus). */
  costBasis: number;
  lastTradeDate: string;
}

export interface TrImport {
  positions: TrPosition[];
  cashTransactions: TransactionInput[];
  stats: { rows: number; trades: number; cash: number; skipped: number; from: string | null; to: string | null; dividends: number; interest: number; fees: number; taxes: number };
  warnings: string[];
  error?: string;
}

const SELL = /sell|verkauf|vente|sale|redemption|maturity|tilgung/;
const BUY = /buy|kauf|achat|savingsplan|sparplan|plan|roundup|saveback|purchase/;
const DIVIDEND = /dividend|dividende|coupon|kupon|distribution|ausschuttung/;
const INTEREST = /interest|zins|interet/;
const CARD = /card|karte|carte/;
const TRANSFER = /deposit|withdraw|einzahlung|auszahlung|transfer|depot|virement|retrait|topup|payout|payin/;

function assetClassOf(raw: string, name: string): AssetClass {
  const t = norm(raw);
  if (/etf|fund|fonds/.test(t) || /\betf\b|ucits|ishares|amundi|vanguard|xtrackers|lyxor/i.test(name)) return "etf";
  if (/bond|anleihe|oblig/.test(t)) return "obligation";
  if (/crypto|krypto/.test(t)) return "crypto";
  if (/stock|aktie|action|equity|share/.test(t) || t === "") return "action";
  return "autre";
}

/** Lit l'export et reconstitue positions et mouvements d'espèces. Tolérant sur le nom exact des colonnes. */
export function parseTradeRepublicCsv(text: string, accountId: number | null = null): TrImport {
  const empty: TrImport = { positions: [], cashTransactions: [], stats: { rows: 0, trades: 0, cash: 0, skipped: 0, from: null, to: null, dividends: 0, interest: 0, fees: 0, taxes: 0 }, warnings: [] };
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) return { ...empty, error: "Fichier vide ou sans ligne de données." };
  const headerLine = lines[0]!;
  const delimiter = [",", ";", "\t"].sort((a, b) => headerLine.split(b).length - headerLine.split(a).length)[0]!;
  const header = splitLine(headerLine, delimiter).map(norm);
  const col = (...names: string[]) => header.findIndex((h) => names.includes(h));

  const idx = {
    date: col("datetime", "date", "datum", "timestamp"),
    category: col("category", "kategorie", "categorie"),
    type: col("type", "typ", "transactiontype"),
    assetClass: col("assetclass", "assettype", "anlageklasse"),
    name: col("name", "title", "description", "titel", "instrument"),
    isin: col("symbol", "isin"),
    shares: col("shares", "quantity", "stuck", "anzahl", "quantite"),
    price: col("price", "preis", "prix"),
    amount: col("amount", "betrag", "montant", "value"),
    fee: col("fee", "fees", "gebuhr", "frais"),
    tax: col("tax", "taxes", "steuer", "impot"),
    id: col("transactionid", "id", "reference"),
  };
  if (idx.date < 0 || idx.amount < 0 || (idx.type < 0 && idx.category < 0)) {
    return { ...empty, error: "Ce fichier ne ressemble pas à l'export des transactions de Trade Republic (colonnes date, type et montant attendues)." };
  }

  const rows = lines.slice(1).map((l) => splitLine(l, delimiter)).map((c) => ({
    date: (c[idx.date] ?? "").slice(0, 10),
    kind: norm(`${idx.category >= 0 ? c[idx.category] ?? "" : ""} ${idx.type >= 0 ? c[idx.type] ?? "" : ""}`),
    assetClass: idx.assetClass >= 0 ? c[idx.assetClass] ?? "" : "",
    name: idx.name >= 0 ? c[idx.name] ?? "" : "",
    isin: idx.isin >= 0 ? (c[idx.isin] ?? "").toUpperCase() : "",
    shares: idx.shares >= 0 ? parseNumber(c[idx.shares]) : null,
    price: idx.price >= 0 ? parseNumber(c[idx.price]) : null,
    amount: parseNumber(c[idx.amount]),
    fee: idx.fee >= 0 ? Math.abs(parseNumber(c[idx.fee]) ?? 0) : 0,
    tax: idx.tax >= 0 ? Math.abs(parseNumber(c[idx.tax]) ?? 0) : 0,
    id: idx.id >= 0 ? c[idx.id] ?? "" : "",
  })).sort((a, b) => a.date.localeCompare(b.date));

  const out: TrImport = { ...empty, stats: { ...empty.stats, rows: rows.length }, warnings: [] };
  const book = new Map<string, TrPosition>();

  for (const r of rows) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) {
      out.stats.skipped++;
      continue;
    }
    out.stats.from ??= r.date;
    out.stats.to = r.date;
    out.stats.fees += r.fee;
    out.stats.taxes += r.tax;

    const isTrade = r.shares !== null && r.shares !== 0 && (r.isin !== "" || r.name !== "") && !DIVIDEND.test(r.kind) && !INTEREST.test(r.kind);
    if (isTrade) {
      const selling = r.shares! < 0 || (SELL.test(r.kind) && !BUY.test(r.kind));
      const quantity = Math.abs(r.shares!);
      // Le montant est le flux d'espèces réellement débité : on le prend tel quel. Les frais ne sont
      // ajoutés que lorsqu'il faut reconstituer le montant à partir du cours d'exécution.
      const gross = r.amount !== null && r.amount !== 0 ? Math.abs(r.amount) : r.price !== null ? quantity * r.price + r.fee : null;
      if (gross === null) {
        out.stats.skipped++;
        continue;
      }
      const key = r.isin || norm(r.name);
      const position = book.get(key) ?? { isin: r.isin || null, name: r.name || r.isin, assetClass: assetClassOf(r.assetClass, r.name), shares: 0, costBasis: 0, lastTradeDate: r.date };
      if (selling) {
        const sold = Math.min(quantity, Math.max(position.shares, 0));
        if (position.shares > 0) position.costBasis -= position.costBasis * (sold / position.shares);
        position.shares -= quantity;
      } else {
        position.shares += quantity;
        position.costBasis += gross;
      }
      if (r.name) position.name = r.name;
      position.lastTradeDate = r.date;
      book.set(key, position);
      out.stats.trades++;
      continue;
    }

    if (r.amount === null || r.amount === 0) {
      out.stats.skipped++;
      continue;
    }
    let category: string | undefined;
    let label = r.name || "Trade Republic";
    if (DIVIDEND.test(r.kind)) {
      category = "revenus";
      label = `Dividende ${r.name}`.trim();
      out.stats.dividends += r.amount;
    } else if (INTEREST.test(r.kind)) {
      category = "revenus";
      label = "Intérêts Trade Republic";
      out.stats.interest += r.amount;
    } else if (TRANSFER.test(r.kind) && !CARD.test(r.kind)) {
      category = "épargne et placements";
      label = r.name || (r.amount > 0 ? "Versement vers Trade Republic" : "Retrait de Trade Republic");
    }
    out.cashTransactions.push({ accountId, date: r.date, label: label.slice(0, 200), amount: r.amount, category, source: TR_SOURCE, externalId: r.id || undefined });
    out.stats.cash++;
  }

  for (const position of book.values()) {
    if (position.shares < -1e-6) out.warnings.push(`${position.name} : plus de titres vendus qu'achetés dans ce fichier. L'export ne couvre sans doute pas tout l'historique — refais-le « depuis le début ».`);
    else if (position.shares > 1e-6) out.positions.push({ ...position, shares: Math.round(position.shares * 1e6) / 1e6, costBasis: Math.round(position.costBasis * 100) / 100 });
  }
  out.positions.sort((a, b) => b.costBasis - a.costBasis);
  for (const k of ["dividends", "interest", "fees", "taxes"] as const) out.stats[k] = Math.round(out.stats[k] * 100) / 100;
  if (out.stats.trades === 0 && out.stats.cash === 0) out.error = "Aucune ligne exploitable dans ce fichier.";
  return out;
}


const simplify = (s: string): string => norm(s).replace(/(inc|corp|corporation|sa|se|ag|plc|nv|ltd|class[abc]|registered|shares|technology|technologies|group|holdings?)$/g, "");

/**
 * Applique un import au compte choisi. Idempotent : réimporter l'export complet redonne le même état.
 * Les valeurs de marché déjà saisies à la main sont conservées (rapprochement par ISIN).
 */
export function applyTradeRepublicImport(db: DB, accountId: number, parsed: TrImport): { positions: number; inserted: number; duplicates: number; merged: string[] } {
  const merged: string[] = [];
  let result = { inserted: 0, duplicates: 0 };
  db.transaction(() => {
    const existing = repo.listHoldings(db);
    const previous = existing.filter((h) => h.accountId === accountId && h.source === TR_SOURCE);
    for (const h of previous) repo.deleteHolding(db, h.id);

    for (const p of parsed.positions) {
      const before = previous.find((h) => (p.isin && h.isin === p.isin) || norm(h.name) === norm(p.name));
      // Une ligne saisie à la main, sans valeur ni compte, portant le même nom : c'est la même position.
      const manual = existing.find((h) => h.source !== TR_SOURCE && h.value === null && (h.accountId === null || h.accountId === accountId) && simplify(h.name) !== "" && (simplify(p.name).startsWith(simplify(h.name)) || simplify(h.name).startsWith(simplify(p.name))));
      if (manual) {
        repo.deleteHolding(db, manual.id);
        merged.push(manual.name);
      }
      repo.createHolding(db, {
        accountId, name: p.name, isin: p.isin, assetClass: p.assetClass, quantity: p.shares, costBasis: p.costBasis, source: TR_SOURCE,
        sector: before?.sector ?? manual?.sector ?? null, value: before?.value ?? null, asOf: before?.asOf ?? null,
      });
    }
    result = repo.insertTransactions(db, parsed.cashTransactions.map((t) => ({ ...t, accountId })), categorize);
    repo.audit(db, "utilisateur", "import.trade_republic", `${parsed.positions.length} position(s), ${result.inserted} mouvement(s) d'espèces`);
  })();
  return { positions: parsed.positions.length, ...result, merged };
}
