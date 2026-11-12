import type { TransactionInput } from "@/lib/db/repo";

/** Découpe une ligne CSV en respectant les guillemets. */
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

export function parseAmount(raw: string): number | null {
  const cleaned = raw.replace(/[\s  €]/g, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", ".");
  if (cleaned === "" || !/^[-+]?\d*\.?\d+$/.test(cleaned)) return null;
  return Number(cleaned);
}

export function parseDate(raw: string): string | null {
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const fr = raw.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
  if (fr) {
    const year = fr[3]!.length === 2 ? `20${fr[3]}` : fr[3]!;
    return `${year}-${fr[2]!.padStart(2, "0")}-${fr[1]!.padStart(2, "0")}`;
  }
  return null;
}

const norm = (s: string): string => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z]/g, "");

export interface CsvParseResult {
  transactions: TransactionInput[];
  skipped: number;
  error?: string;
}

/**
 * Lit un relevé CSV exporté depuis une banque (BoursoBank et formats voisins).
 * Les colonnes sont reconnues par leur en-tête : date, libellé, montant (ou débit / crédit).
 */
export function parseBankCsv(text: string, accountId: number | null = null): CsvParseResult {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) return { transactions: [], skipped: 0, error: "Fichier vide ou sans ligne de données." };
  const headerLine = lines[0]!;
  const delimiter = [";", ",", "\t"].sort((a, b) => headerLine.split(b).length - headerLine.split(a).length)[0]!;
  const header = splitLine(headerLine, delimiter).map(norm);

  const find = (...names: string[]) => header.findIndex((h) => names.includes(h));
  const dateIdx = find("dateop", "date", "dateoperation", "datedoperation", "datecomptable", "dateval");
  const labelIdx = find("label", "libelle", "libellesimplifie", "description", "intitule", "libelleoperation");
  const amountIdx = find("amount", "montant", "montanteur");
  const debitIdx = find("debit");
  const creditIdx = find("credit");
  if (dateIdx < 0 || labelIdx < 0 || (amountIdx < 0 && debitIdx < 0 && creditIdx < 0)) {
    return { transactions: [], skipped: 0, error: "Colonnes non reconnues : il faut au minimum une date, un libellé et un montant." };
  }

  const transactions: TransactionInput[] = [];
  let skipped = 0;
  for (const line of lines.slice(1)) {
    const cells = splitLine(line, delimiter);
    const date = parseDate(cells[dateIdx] ?? "");
    const label = cells[labelIdx] ?? "";
    let amount: number | null = amountIdx >= 0 ? parseAmount(cells[amountIdx] ?? "") : null;
    if (amount === null) {
      const debit = debitIdx >= 0 ? parseAmount(cells[debitIdx] ?? "") : null;
      const credit = creditIdx >= 0 ? parseAmount(cells[creditIdx] ?? "") : null;
      if (debit !== null && debit !== 0) amount = -Math.abs(debit);
      else if (credit !== null) amount = Math.abs(credit);
    }
    if (!date || !label || amount === null) {
      skipped++;
      continue;
    }
    transactions.push({ accountId, date, label, amount, source: "import CSV" });
  }
  return { transactions, skipped };
}
