import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, authEnabled, verifySessionToken } from "@/lib/security/auth";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Contrôles appliqués à chaque requête :
 *  1. les écritures doivent provenir de l'application elle-même (protection CSRF par l'origine) ;
 *  2. si un mot de passe est configuré, toute page et toute API exigent une session valide.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (MUTATING.has(request.method)) {
    const origin = request.headers.get("origin");
    const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
    if (origin && host && new URL(origin).host !== host) {
      return NextResponse.json({ error: "Origine refusée" }, { status: 403 });
    }
  }

  if (!authEnabled() || pathname === "/login" || pathname === "/api/auth") return NextResponse.next();
  if (verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();

  if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Authentification requise" }, { status: 401 });
  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg).*)"] };
