import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "session";
const SESSION_DAYS = 30;

export const authEnabled = (): boolean => Boolean(process.env.APP_PASSWORD);

const sign = (payload: string): string => createHmac("sha256", process.env.APP_PASSWORD ?? "").update(payload).digest("hex");

const safeEqual = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function checkPassword(candidate: string): boolean {
  const expected = process.env.APP_PASSWORD ?? "";
  // Comparaison sur des condensats de longueur fixe : ni la longueur ni le contenu ne fuient par le temps de réponse.
  return expected !== "" && safeEqual(sign(`pw:${candidate}`), sign(`pw:${expected}`));
}

/** Jeton de session signé : « expiration.signature ». Aucune donnée personnelle dedans. */
export function createSessionToken(nowMs: number = Date.now()): string {
  const expires = String(nowMs + SESSION_DAYS * 86_400_000);
  return `${expires}.${sign(`session:${expires}`)}`;
}

export function verifySessionToken(token: string | undefined, nowMs: number = Date.now()): boolean {
  if (!token) return false;
  const [expires, signature] = token.split(".");
  if (!expires || !signature || !/^\d+$/.test(expires)) return false;
  return Number(expires) > nowMs && safeEqual(signature, sign(`session:${expires}`));
}

export const SESSION_MAX_AGE = SESSION_DAYS * 86_400;
