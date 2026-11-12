import { categorize } from "@/lib/budget/categorize";
import type { DB } from "@/lib/db/client";
import * as repo from "@/lib/db/repo";
import { refreshAlerts } from "@/lib/monitor/alerts";
import { BankApiError, createSession, deleteSession, getBalances, getTransactions, maskIban, pickBalance, type ApiAccount, type ApiTransaction, type BankApiConfig } from "./enablebanking";

const PROVIDER_LABEL = "Enable Banking (lecture seule)";
const FIRST_SYNC_DAYS = 90;
const OVERLAP_DAYS = 7;

const isoDaysAgo = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

const accountLabel = (a: ApiAccount): string => a.details || a.product || a.name || (a.cash_account_type === "SVGS" ? "Compte d'épargne" : "Compte");

export function transactionToInput(t: ApiTransaction, accountId: number): repo.TransactionInput | null {
  const date = t.booking_date ?? t.value_date ?? t.transaction_date;
  const amount = Number(t.transaction_amount.amount);
  if (t.status !== "BOOK" || !date || !Number.isFinite(amount)) return null;
  const debit = t.credit_debit_indicator === "DBIT";
  const counterparty = debit ? t.creditor?.name : t.debtor?.name;
  const label = (t.remittance_information ?? []).join(" ").replace(/\s+/g, " ").trim() || counterparty || "Opération";
  return { accountId, date, label: label.slice(0, 200), amount: debit ? -Math.abs(amount) : Math.abs(amount), source: PROVIDER_LABEL, externalId: t.entry_reference ?? t.transaction_id };
}

/** Finalise une autorisation revenue de la banque : ouvre la session et enregistre les comptes autorisés. */
export async function completeAuthorization(db: DB, config: BankApiConfig, state: string, code: string): Promise<repo.BankConnection> {
  const pending = repo.findPendingConnectionByState(db, state);
  if (!pending) throw new BankApiError("Demande de connexion inconnue ou déjà utilisée.", 400);
  const session = await createSession(config, code);
  repo.activateConnection(db, pending.id, session.session_id, session.access?.valid_until ?? null);
  repo.replaceBankAccounts(db, pending.id, session.accounts.filter((a) => a.uid).map((a) => ({
    externalUid: a.uid!, identificationHash: a.identification_hash, label: accountLabel(a), ibanMasked: maskIban(a.account_id?.iban), accountType: a.cash_account_type, currency: a.currency,
  })));

  // Rattachement automatique seulement quand il est sans ambiguïté : un seul compte courant de chaque côté.
  const links = repo.listBankAccounts(db, pending.id);
  const linkedIds = new Set(repo.listBankAccounts(db).map((l) => l.accountId).filter((x): x is number => x !== null));
  const localChecking = repo.listAccounts(db).filter((a) => a.kind === "courant" && !linkedIds.has(a.id));
  const remoteChecking = links.filter((l) => l.accountType === "CACC" && l.accountId === null);
  if (localChecking.length === 1 && remoteChecking.length === 1) repo.linkBankAccount(db, remoteChecking[0]!.id, localChecking[0]!.id);
  return repo.getConnection(db, pending.id)!;
}

export interface SyncReport { connection: string; accounts: number; balancesUpdated: number; inserted: number; duplicates: number; error?: string }

/** Lit soldes et opérations des comptes rattachés. Lecture seule : aucune écriture n'est faite côté banque. */
export async function syncConnection(db: DB, config: BankApiConfig, connectionId: number): Promise<SyncReport> {
  const connection = repo.getConnection(db, connectionId);
  if (!connection) throw new BankApiError("Connexion introuvable.", 404);
  const report: SyncReport = { connection: connection.aspspName, accounts: 0, balancesUpdated: 0, inserted: 0, duplicates: 0 };
  if (connection.status === "expiree" || (connection.validUntil && Date.parse(connection.validUntil) < Date.now())) {
    repo.setConnectionState(db, connectionId, { status: "expiree", lastError: "Le consentement a expiré : une nouvelle autorisation est nécessaire." });
    return { ...report, error: "Consentement expiré" };
  }
  const dateFrom = connection.lastSyncAt ? isoDaysAgo(OVERLAP_DAYS + Math.ceil((Date.now() - Date.parse(connection.lastSyncAt)) / 86_400_000)) : isoDaysAgo(FIRST_SYNC_DAYS);

  try {
    for (const link of repo.listBankAccounts(db, connectionId)) {
      if (link.accountId === null) continue;
      report.accounts++;
      const balance = pickBalance(await getBalances(config, link.externalUid), link.currency);
      if (balance) {
        const amount = Number(balance.balance_amount.amount);
        const local = repo.listAccounts(db).find((a) => a.id === link.accountId);
        if (local && Number.isFinite(amount)) {
          repo.updateAccount(db, local.id, { balance: amount, asOf: repo.today(), source: PROVIDER_LABEL }, "systeme");
          report.balancesUpdated++;
        }
      }
      const inputs = (await getTransactions(config, link.externalUid, dateFrom)).map((t) => transactionToInput(t, link.accountId!)).filter((t): t is repo.TransactionInput => t !== null);
      const result = repo.insertTransactions(db, inputs, categorize, "systeme");
      report.inserted += result.inserted;
      report.duplicates += result.duplicates;
    }
    repo.setConnectionState(db, connectionId, { status: "active", lastSyncAt: new Date().toISOString(), lastError: null });
  } catch (error) {
    const expired = error instanceof BankApiError && (error.status === 401 || /EXPIRED|REVOKED|CLOSED/.test(error.code ?? ""));
    const message = error instanceof BankApiError ? error.message : "Synchronisation impossible (réseau ou service indisponible).";
    repo.setConnectionState(db, connectionId, { status: expired ? "expiree" : "erreur", lastError: message });
    report.error = message;
  }
  refreshAlerts(db);
  return report;
}

export async function disconnect(db: DB, config: BankApiConfig | null, connectionId: number): Promise<void> {
  const connection = repo.getConnection(db, connectionId);
  if (connection?.sessionId && config) {
    // Révocation au mieux : la connexion locale est supprimée même si le service ne répond pas.
    await deleteSession(config, connection.sessionId).catch(() => undefined);
  }
  repo.deleteConnection(db, connectionId);
}
