import { z } from "zod";
import { SESSION_COOKIE, SESSION_MAX_AGE, checkPassword, createSessionToken } from "@/lib/security/auth";
import { handle, json } from "@/lib/server";

const attempts = new Map<string, { count: number; until: number }>();

export const POST = handle(async (request: Request) => {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  const entry = attempts.get(ip);
  if (entry && entry.count >= 5 && entry.until > Date.now()) return json({ error: "Trop de tentatives. Réessaie dans quelques minutes." }, 429);

  const { password } = z.object({ password: z.string().max(500) }).parse(await request.json());
  if (!checkPassword(password)) {
    attempts.set(ip, { count: (entry && entry.until > Date.now() ? entry.count : 0) + 1, until: Date.now() + 10 * 60_000 });
    return json({ error: "Mot de passe incorrect" }, 401);
  }
  attempts.delete(ip);
  const response = json({ ok: true });
  response.cookies.set(SESSION_COOKIE, createSessionToken(), { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", path: "/", maxAge: SESSION_MAX_AGE });
  return response;
});

export const DELETE = handle(async () => {
  const response = json({ ok: true });
  response.cookies.delete(SESSION_COOKIE);
  return response;
});
