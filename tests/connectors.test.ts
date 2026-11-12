import { createVerify, generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { buildContext } from "@/lib/ai/context";
import { detectIntent } from "@/lib/ai/local";
import { runSpecialists } from "@/lib/ai/specialists";
import { BankApiError, createJwt, maskIban, pickBalance, type BankApiConfig } from "@/lib/connectors/enablebanking";
import { completeAuthorization, disconnect, syncConnection, transactionToInput } from "@/lib/connectors/sync";
import { TR_SOURCE, applyTradeRepublicImport, parseNumber, parseTradeRepublicCsv } from "@/lib/connectors/traderepublic";
import { openDatabase, type DB } from "@/lib/db/client";
import * as repo from "@/lib/db/repo";
import { importSituation } from "@/lib/db/seed";
import { SITUATION } from "./fixtures";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const APP_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const verifyJwt = (jwt: string): { header: Record<string, string>; claims: Record<string, number | string> } | null => {
  const [h, b, s] = jwt.split(".");
  if (!h || !b || !s || !createVerify("RSA-SHA256").update(`${h}.${b}`).verify(publicKey, Buffer.from(s, "base64url"))) return null;
  return { header: JSON.parse(Buffer.from(h, "base64url").toString()), claims: JSON.parse(Buffer.from(b, "base64url").toString()) };
};

/** Faux service reproduisant les réponses documentées de l'API, avec vérification de la signature. */
function fakeBank(options: { failWith?: number } = {}) {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.pathname}${url.search}`);
    const auth = new Headers(init?.headers).get("Authorization") ?? "";
    const token = verifyJwt(auth.replace("Bearer ", ""));
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    if (!token || token.header.kid !== APP_ID || token.claims.aud !== "api.enablebanking.com") return reply(401, { message: "Unauthorized", error: "UNAUTHORIZED" });
    if (options.failWith && url.pathname.startsWith("/accounts")) return reply(options.failWith, { message: "Session expired", error: "EXPIRED_SESSION" });

    if (method === "POST" && url.pathname === "/sessions") {
      return reply(200, { session_id: "sess-1", access: { valid_until: new Date(Date.now() + 90 * 86_400_000).toISOString() }, accounts: [
        { uid: "acc-courant", identification_hash: "hash-1", account_id: { iban: "FR7600000000000000000001234" }, details: "Compte bancaire", cash_account_type: "CACC", currency: "EUR" },
        { uid: "acc-livret", identification_hash: "hash-2", account_id: { iban: "FR7600000000000000000005678" }, product: "Livret", cash_account_type: "SVGS", currency: "EUR" },
      ] });
    }
    if (url.pathname === "/accounts/acc-courant/balances") {
      return reply(200, { balances: [{ name: "Disponible", balance_amount: { amount: "1999.00", currency: "EUR" }, balance_type: "CLAV" }, { name: "Comptable", balance_amount: { amount: "2345.67", currency: "EUR" }, balance_type: "CLBD" }] });
    }
    if (url.pathname === "/accounts/acc-courant/transactions") {
      if (!url.searchParams.get("continuation_key")) {
        return reply(200, { continuation_key: "page2", transactions: [
          { entry_reference: "ref-1", transaction_amount: { amount: "42.10", currency: "EUR" }, credit_debit_indicator: "DBIT", status: "BOOK", booking_date: "2026-11-02", remittance_information: ["CARTE 01/11", "CARREFOUR CITY"] },
          { entry_reference: "ref-2", transaction_amount: { amount: "2500.00", currency: "EUR" }, credit_debit_indicator: "CRDT", status: "BOOK", booking_date: "2026-11-03", remittance_information: ["VIR SALAIRE NOVEMBRE"] },
        ] });
      }
      return reply(200, { continuation_key: null, transactions: [
        { entry_reference: "ref-3", transaction_amount: { amount: "13.49", currency: "EUR" }, credit_debit_indicator: "DBIT", status: "BOOK", booking_date: "2026-11-05", creditor: { name: "NETFLIX" } },
        { entry_reference: "ref-4", transaction_amount: { amount: "9.99", currency: "EUR" }, credit_debit_indicator: "DBIT", status: "PDNG", booking_date: "2026-11-06", remittance_information: ["EN ATTENTE"] },
      ] });
    }
    if (method === "DELETE" && url.pathname === "/sessions/sess-1") return reply(200, { message: "OK" });
    return reply(404, { message: "Not found" });
  }) as typeof fetch;
  const config: BankApiConfig = { applicationId: APP_ID, privateKey: PEM, fetchImpl };
  return { config, calls };
}

let db: DB;
beforeEach(() => {
  db = openDatabase(":memory:");
  importSituation(db, SITUATION);
});

const connect = async (config: BankApiConfig) => {
  const state = "a".repeat(64);
  repo.createPendingConnection(db, { provider: "enablebanking", aspspName: "BoursoBank", aspspCountry: "FR", state, validUntil: new Date(Date.now() + 90 * 86_400_000).toISOString() });
  return completeAuthorization(db, config, state, "code-123");
};

describe("connexion bancaire en lecture seule", () => {
  it("signe un jeton d'application RS256 de courte durée", () => {
    const token = verifyJwt(createJwt({ applicationId: APP_ID, privateKey: PEM, now: () => 1_700_000_000_000 }))!;
    expect(token.header).toEqual({ typ: "JWT", alg: "RS256", kid: APP_ID });
    expect(token.claims).toMatchObject({ iss: "enablebanking.com", aud: "api.enablebanking.com", iat: 1_700_000_000 });
    expect(Number(token.claims.exp) - Number(token.claims.iat)).toBeLessThanOrEqual(3600);
  });
  it("ne conserve que la fin de l'IBAN et préfère le solde comptable", () => {
    expect(maskIban("FR76 3000 4000 0312 3456 7890 143")).toBe("•••• 0143");
    expect(maskIban(undefined)).toBeNull();
    expect(pickBalance([{ name: "a", balance_amount: { amount: "1", currency: "EUR" }, balance_type: "CLAV" }, { name: "b", balance_amount: { amount: "2", currency: "EUR" }, balance_type: "CLBD" }])?.balance_amount.amount).toBe("2");
  });
  it("convertit une opération bancaire en écriture signée, sans les opérations en attente", () => {
    const base = { transaction_amount: { amount: "10.00", currency: "EUR" }, status: "BOOK", booking_date: "2026-11-01" } as const;
    expect(transactionToInput({ ...base, credit_debit_indicator: "DBIT", creditor: { name: "SNCF" }, entry_reference: "x" }, 1)).toMatchObject({ amount: -10, label: "SNCF", externalId: "x" });
    expect(transactionToInput({ ...base, credit_debit_indicator: "CRDT" }, 1)?.amount).toBe(10);
    expect(transactionToInput({ ...base, credit_debit_indicator: "DBIT", status: "PDNG" }, 1)).toBeNull();
  });
  it("refuse un retour de banque dont le jeton d'état est inconnu", async () => {
    const { config, calls } = fakeBank();
    await expect(completeAuthorization(db, config, "b".repeat(64), "code")).rejects.toBeInstanceOf(BankApiError);
    expect(calls).toHaveLength(0);
  });
  it("ouvre la session, rattache le compte courant sans ambiguïté et n'enregistre aucun IBAN complet", async () => {
    const { config } = fakeBank();
    const connection = await connect(config);
    expect(connection.status).toBe("active");
    const links = repo.listBankAccounts(db, connection.id);
    expect(links).toHaveLength(2);
    expect(links[0]!.accountId).toBe(repo.listAccounts(db).find((a) => a.kind === "courant")!.id);
    expect(links[1]!.accountId).toBeNull();
    expect(JSON.stringify(links)).not.toContain("FR76");
    // Le jeton d'état est à usage unique.
    await expect(completeAuthorization(db, config, "a".repeat(64), "code-123")).rejects.toBeInstanceOf(BankApiError);
  });
  it("synchronise solde et opérations, pages comprises, et ne duplique rien au passage suivant", async () => {
    const { config, calls } = fakeBank();
    const connection = await connect(config);
    const report = await syncConnection(db, config, connection.id);
    expect(report).toMatchObject({ accounts: 1, balancesUpdated: 1, inserted: 3, duplicates: 0 });
    expect(report.error).toBeUndefined();
    const checking = repo.listAccounts(db).find((a) => a.kind === "courant")!;
    expect(checking.balance).toBe(2345.67);
    expect(checking.source).toMatch(/lecture seule/);
    const tx = repo.listTransactions(db);
    expect(tx.map((t) => t.amount).sort((a, b) => a - b)).toEqual([-42.1, -13.49, 2500]);
    expect(tx.find((t) => t.amount === -42.1)?.category).toBe("courses");
    expect(tx.find((t) => t.amount === 2500)?.category).toBe("revenus");
    expect(calls.some((c) => c.includes("continuation_key=page2"))).toBe(true);
    expect(buildContext(db).netWorth.liquid).toBe(2345.67 + 800);

    const again = await syncConnection(db, config, connection.id);
    expect(again).toMatchObject({ inserted: 0, duplicates: 3 });
    // Lecture seule : aucun appel d'écriture vers la banque, aucun service de paiement.
    expect(calls.filter((c) => !c.startsWith("GET ") && c !== "POST /sessions")).toEqual([]);
    expect(calls.some((c) => c.includes("/payments"))).toBe(false);
  });
  it("marque la connexion expirée, le signale, et conserve les données déjà importées", async () => {
    const ok = fakeBank();
    const connection = await connect(ok.config);
    await syncConnection(db, ok.config, connection.id);
    const report = await syncConnection(db, fakeBank({ failWith: 401 }).config, connection.id);
    expect(report.error).toBeDefined();
    expect(repo.getConnection(db, connection.id)?.status).toBe("expiree");
    expect(repo.listTransactions(db)).toHaveLength(3);
    expect(runSpecialists(buildContext(db)).some((f) => f.key.startsWith("patrimoine.connexion_expiree"))).toBe(true);
  });
  it("révoque la session à la déconnexion, même si le service ne répond pas", async () => {
    const { config, calls } = fakeBank();
    const connection = await connect(config);
    await disconnect(db, config, connection.id);
    expect(calls).toContain("DELETE /sessions/sess-1");
    expect(repo.listConnections(db)).toHaveLength(0);
    expect(repo.listBankAccounts(db)).toHaveLength(0);
  });
});

const TR_CSV = `datetime,date,account_type,category,type,asset_class,name,symbol,shares,price,amount,fee,tax,currency,transaction_id
2025-01-10T09:00:00Z,2025-01-10,CASH,CASH,DEPOSIT,,Einzahlung,,,,1000.00,0,0,EUR,t1
2025-01-15T10:00:00Z,2025-01-15,SECURITIES,TRADING,BUY,STOCK,Apple Inc.,US0378331005,2,180.00,-361.00,1.00,0,EUR,t2
2025-02-15T10:00:00Z,2025-02-15,SECURITIES,TRADING,BUY,STOCK,Apple Inc.,US0378331005,2,200.00,-401.00,1.00,0,EUR,t3
2025-03-01T10:00:00Z,2025-03-01,SECURITIES,TRADING,SELL,STOCK,Apple Inc.,US0378331005,-1,220.00,219.00,1.00,0,EUR,t4
2025-03-02T10:00:00Z,2025-03-02,SECURITIES,TRADING,SAVINGS_PLAN,FUND,iShares Core S&P 500 UCITS ETF,IE00B5BMR087,0.125,480.00,-60.00,0,0,EUR,t5
2025-03-10T10:00:00Z,2025-03-10,SECURITIES,CASH,DIVIDEND,STOCK,Apple Inc.,US0378331005,,,0.66,0,0.20,EUR,t6
2025-04-01T10:00:00Z,2025-04-01,CASH,CASH,INTEREST,,Zinsen,,,,1.23,0,0.37,EUR,t7
2025-04-05T10:00:00Z,2025-04-05,CASH,CARD,CARD_PAYMENT,,CARREFOUR CITY,,,,-23.40,0,0,EUR,t8
2025-04-06T10:00:00Z,2025-04-06,SECURITIES,TRADING,SELL,STOCK,Micron Technology,US5951121038,-3,90.00,270.00,1.00,0,EUR,t9
ligne illisible`;

describe("import Trade Republic", () => {
  it("lit les nombres aux formats international et européen", () => {
    expect(parseNumber("0.125")).toBe(0.125);
    expect(parseNumber("1,234.56")).toBe(1234.56);
    expect(parseNumber("1.234,56")).toBe(1234.56);
    expect(parseNumber("-361,00")).toBe(-361);
    expect(parseNumber("")).toBeNull();
    expect(parseNumber("abc")).toBeNull();
  });
  it("reconstitue les positions au prix moyen pondéré, sans aucune valeur de marché", () => {
    const r = parseTradeRepublicCsv(TR_CSV);
    expect(r.error).toBeUndefined();
    const apple = r.positions.find((p) => p.isin === "US0378331005")!;
    expect(apple.shares).toBe(3);
    // (361 + 401) × 3/4 : la vente retire un quart du prix de revient.
    expect(apple.costBasis).toBe(571.5);
    const etf = r.positions.find((p) => p.isin === "IE00B5BMR087")!;
    expect(etf).toMatchObject({ shares: 0.125, costBasis: 60, assetClass: "etf" });
    expect(r.positions.every((p) => !("value" in p))).toBe(true);
    expect(r.stats).toMatchObject({ trades: 5, cash: 4, skipped: 1, dividends: 0.66, interest: 1.23, fees: 4, taxes: 0.57, from: "2025-01-10", to: "2025-04-06" });
  });
  it("classe les mouvements d'espèces et signale un export incomplet", () => {
    const r = parseTradeRepublicCsv(TR_CSV);
    const byId = Object.fromEntries(r.cashTransactions.map((t) => [t.externalId, t]));
    expect(byId.t1).toMatchObject({ amount: 1000, category: "épargne et placements" });
    expect(byId.t6).toMatchObject({ category: "revenus", label: "Dividende Apple Inc." });
    expect(byId.t8?.category).toBeUndefined();
    expect(r.positions.some((p) => p.name.includes("Micron"))).toBe(false);
    expect(r.warnings[0]).toMatch(/Micron.*depuis le début/);
  });
  it("refuse un fichier qui n'est pas un export de transactions", () => {
    expect(parseTradeRepublicCsv("a,b\n1,2").error).toBeDefined();
    expect(parseTradeRepublicCsv("").error).toBeDefined();
  });
  it("remplace les lignes saisies à la main, reste idempotent et conserve les valeurs saisies", () => {
    const account = repo.listAccounts(db).find((a) => a.name === "Autre compte-titres")!;
    const parsed = parseTradeRepublicCsv(TR_CSV, account.id);
    const first = applyTradeRepublicImport(db, account.id, parsed);
    expect(first).toMatchObject({ positions: 2, inserted: 4, merged: ["Apple"] });
    let holdings = repo.listHoldings(db);
    const apple = holdings.find((h) => h.isin === "US0378331005")!;
    expect(apple).toMatchObject({ quantity: 3, costBasis: 571.5, value: null, sector: "Technologie", accountId: account.id, source: TR_SOURCE });
    expect(holdings.filter((h) => /apple/i.test(h.name))).toHaveLength(1);
    // Les lignes d'autres titres saisies à la main ne sont pas touchées.
    expect(holdings.some((h) => h.name === "Alphabet")).toBe(true);
    expect(repo.listTransactions(db).find((t) => t.label === "CARREFOUR CITY")?.category).toBe("courses");

    repo.updateHolding(db, apple.id, { name: apple.name, value: 700 });
    const second = applyTradeRepublicImport(db, account.id, parsed);
    expect(second).toMatchObject({ positions: 2, inserted: 0, duplicates: 4 });
    holdings = repo.listHoldings(db);
    expect(holdings.filter((h) => h.source === TR_SOURCE)).toHaveLength(2);
    expect(holdings.find((h) => h.isin === "US0378331005")?.value).toBe(700);
    // Le prix de revient n'entre jamais dans le patrimoine : seul le solde saisi du compte compte.
    expect(buildContext(db).netWorth.total).toBe(7250);
  });
});

describe("assistant et connexions", () => {
  it("oriente vers les voies autorisées", () => {
    expect(detectIntent("Je veux connecter ma banque et trade republic")).toEqual({ kind: "connexion" });
  });
});
