/**
 * Client de l'API Enable Banking (agrégateur agréé, accès DSP2 en LECTURE SEULE).
 *
 * L'utilisateur s'authentifie chez sa banque, sur les pages de la banque : l'application ne voit
 * jamais ses identifiants bancaires. Elle reçoit une session limitée dans le temps, donnant accès
 * aux soldes et aux opérations — rien d'autre. Aucun service de paiement n'est appelé ici.
 *
 * Référence : https://enablebanking.com/docs/api/reference/
 */
import { createSign } from "node:crypto";
import fs from "node:fs";

const BASE_URL = "https://api.enablebanking.com";
const JWT_TTL_SECONDS = 600;

export class BankApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

export interface BankApiConfig {
  applicationId: string;
  privateKey: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

import path from "node:path";

const KEY_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.pem$/i;
const PEM = /^-----BEGIN (RSA )?PRIVATE KEY-----[\s\S]+-----END (RSA )?PRIVATE KEY-----\s*$/;

export const secretsDir = (): string => path.resolve(process.env.ENABLE_BANKING_SECRETS_DIR ?? "./secrets");

/**
 * Configuration de l'accès. Deux façons, par ordre de priorité :
 *  1. variables d'environnement ENABLE_BANKING_APP_ID et ENABLE_BANKING_PRIVATE_KEY_PATH ;
 *  2. le fichier « <identifiant>.pem » tel que téléchargé chez l'agrégateur, déposé dans secrets/
 *     (le nom du fichier est l'identifiant de l'application : rien d'autre à configurer).
 * La clé privée reste dans un fichier hors du dépôt.
 */
export function configFromEnv(): BankApiConfig | null {
  const applicationId = process.env.ENABLE_BANKING_APP_ID;
  const keyPath = process.env.ENABLE_BANKING_PRIVATE_KEY_PATH;
  // Chemins fournis à l'exécution : le bundler ne doit ni les suivre ni surveiller leur dossier.
  if (applicationId && keyPath && fs.existsSync(/* turbopackIgnore: true */ keyPath)) {
    return { applicationId, privateKey: fs.readFileSync(/* turbopackIgnore: true */ keyPath, "utf8") };
  }
  const dir = secretsDir();
  if (!fs.existsSync(/* turbopackIgnore: true */ dir)) return null;
  for (const name of fs.readdirSync(/* turbopackIgnore: true */ dir).sort()) {
    const match = name.match(KEY_FILE);
    if (match) return { applicationId: match[1]!.toLowerCase(), privateKey: fs.readFileSync(/* turbopackIgnore: true */ path.join(dir, name), "utf8") };
  }
  return null;
}

/**
 * Enregistre la clé téléchargée chez l'agrégateur. Le nom du fichier doit être celui d'origine
 * (l'identifiant de l'application) ; une éventuelle clé précédente est remplacée.
 */
export function storeKeyFile(filename: string, pem: string): { applicationId: string } {
  const match = path.basename(filename).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.pem$/i);
  if (!match) throw new BankApiError("Le nom du fichier doit être celui téléchargé chez Enable Banking : l'identifiant de l'application suivi de .pem.", 400);
  if (!PEM.test(pem.trim())) throw new BankApiError("Ce fichier n'est pas une clé privée au format PEM.", 400);
  const dir = secretsDir();
  fs.mkdirSync(/* turbopackIgnore: true */ dir, { recursive: true, mode: 0o700 });
  for (const name of fs.readdirSync(/* turbopackIgnore: true */ dir)) if (KEY_FILE.test(name)) fs.rmSync(/* turbopackIgnore: true */ path.join(dir, name));
  const applicationId = match[1]!.toLowerCase();
  fs.writeFileSync(/* turbopackIgnore: true */ path.join(dir, `${applicationId}.pem`), `${pem.trim()}\n`, { mode: 0o600 });
  return { applicationId };
}

export const redirectUrl = (): string => `${(process.env.APP_URL ?? "https://localhost:3000").replace(/\/$/, "")}/api/bank/callback`;

const b64url = (input: string | Buffer): string => Buffer.from(input).toString("base64url");

/** Jeton d'application signé RS256, de courte durée, régénéré à chaque appel. */
export function createJwt(config: BankApiConfig): string {
  const iat = Math.floor((config.now?.() ?? Date.now()) / 1000);
  const header = b64url(JSON.stringify({ typ: "JWT", alg: "RS256", kid: config.applicationId }));
  const body = b64url(JSON.stringify({ iss: "enablebanking.com", aud: "api.enablebanking.com", iat, exp: iat + JWT_TTL_SECONDS }));
  const signature = createSign("RSA-SHA256").update(`${header}.${body}`).sign(config.privateKey);
  return `${header}.${body}.${b64url(signature)}`;
}

async function call<T>(config: BankApiConfig, method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
  const response = await (config.fetchImpl ?? fetch)(`${BASE_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${createJwt(config)}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* réponse non JSON : traitée comme une erreur ci-dessous */
  }
  if (!response.ok) {
    const err = (data ?? {}) as { message?: string; error?: string };
    throw new BankApiError(err.message ?? `Erreur ${response.status}`, response.status, err.error);
  }
  return data as T;
}

export interface Aspsp { name: string; country: string; psu_types: string[]; maximum_consent_validity: number; beta?: boolean }
export interface ApiAccount {
  uid?: string;
  identification_hash: string;
  account_id?: { iban?: string };
  name?: string;
  details?: string;
  product?: string;
  cash_account_type: string;
  currency: string;
}
export interface ApiBalance { name: string; balance_amount: { amount: string; currency: string }; balance_type: string; reference_date?: string }
export interface ApiTransaction {
  entry_reference?: string;
  transaction_id?: string;
  transaction_amount: { amount: string; currency: string };
  credit_debit_indicator: "CRDT" | "DBIT";
  status: string;
  booking_date?: string;
  value_date?: string;
  transaction_date?: string;
  remittance_information?: string[];
  creditor?: { name?: string };
  debtor?: { name?: string };
}

export async function getApplication(config: BankApiConfig): Promise<{ name: string; environment: string; active: boolean; redirect_urls: string[] }> {
  return call(config, "GET", "/application");
}

export async function listBanks(config: BankApiConfig, country: string): Promise<Aspsp[]> {
  const data = await call<{ aspsps: Aspsp[] }>(config, "GET", `/aspsps?country=${encodeURIComponent(country)}&psu_type=personal`);
  return data.aspsps;
}

/** Démarre l'autorisation : renvoie l'adresse de la banque où l'utilisateur donne son accord. */
export async function startAuthorization(config: BankApiConfig, input: { name: string; country: string; state: string; validUntil: string }): Promise<{ url: string }> {
  return call(config, "POST", "/auth", {
    access: { balances: true, transactions: true, valid_until: input.validUntil },
    aspsp: { name: input.name, country: input.country },
    state: input.state,
    redirect_url: redirectUrl(),
    psu_type: "personal",
    language: "fr",
  });
}

export async function createSession(config: BankApiConfig, code: string): Promise<{ session_id: string; accounts: ApiAccount[]; access?: { valid_until?: string } }> {
  return call(config, "POST", "/sessions", { code });
}

export async function getBalances(config: BankApiConfig, accountUid: string): Promise<ApiBalance[]> {
  const data = await call<{ balances: ApiBalance[] }>(config, "GET", `/accounts/${encodeURIComponent(accountUid)}/balances`);
  return data.balances;
}

/** Opérations depuis une date, toutes pages confondues (plafonné pour éviter une boucle sans fin). */
export async function getTransactions(config: BankApiConfig, accountUid: string, dateFrom: string): Promise<ApiTransaction[]> {
  const all: ApiTransaction[] = [];
  let continuation: string | undefined;
  for (let page = 0; page < 50; page++) {
    const query = new URLSearchParams({ date_from: dateFrom });
    if (continuation) query.set("continuation_key", continuation);
    const data = await call<{ transactions: ApiTransaction[]; continuation_key?: string | null }>(config, "GET", `/accounts/${encodeURIComponent(accountUid)}/transactions?${query}`);
    all.push(...data.transactions);
    if (!data.continuation_key) break;
    continuation = data.continuation_key;
  }
  return all;
}

/** Révoque la session ; la banque clôt le consentement quand elle le permet. */
export async function deleteSession(config: BankApiConfig, sessionId: string): Promise<void> {
  await call(config, "DELETE", `/sessions/${encodeURIComponent(sessionId)}`);
}

/** Solde comptable de préférence, sinon le plus proche disponible. */
const BALANCE_PRIORITY = ["CLBD", "ITBD", "XPCD", "CLAV", "ITAV", "VALU", "OTHR", "INFO"];
export function pickBalance(balances: ApiBalance[], currency = "EUR"): ApiBalance | null {
  const candidates = balances.filter((b) => b.balance_amount.currency === currency);
  for (const type of BALANCE_PRIORITY) {
    const found = candidates.find((b) => b.balance_type === type);
    if (found) return found;
  }
  return candidates[0] ?? null;
}

/** Ne conserve que les quatre derniers caractères de l'IBAN : assez pour reconnaître le compte, pas pour l'utiliser. */
export const maskIban = (iban: string | undefined): string | null => (iban ? `•••• ${iban.replace(/\s/g, "").slice(-4)}` : null);
