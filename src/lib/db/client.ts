import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { MIGRATIONS } from "./schema";

export type DB = Database.Database;

function migrate(db: DB): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

export function openDatabase(file: string): DB {
  if (file !== ":memory:") {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  if (file !== ":memory:") {
    // Fichier lisible par le seul utilisateur du système.
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* système de fichiers sans permissions POSIX */
    }
  }
  return db;
}

const globalForDb = globalThis as unknown as { __financeDb?: DB };

/** Connexion unique par processus (survit au rechargement à chaud en développement). */
export function getDb(): DB {
  if (!globalForDb.__financeDb) {
    globalForDb.__financeDb = openDatabase(process.env.DATABASE_PATH ?? "./data/finance.db");
  }
  return globalForDb.__financeDb;
}
