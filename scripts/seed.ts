/** Charge une situation de départ : `npm run seed -- chemin/vers/situation.json` (par défaut seed/situation.local.json). */
import fs from "node:fs";
import path from "node:path";
import { openDatabase } from "../src/lib/db/client";
import { isEmpty } from "../src/lib/db/repo";
import { importSituation } from "../src/lib/db/seed";

const file = path.resolve(process.argv[2] ?? "seed/situation.local.json");
if (!fs.existsSync(file)) {
  console.error(`Fichier introuvable : ${file}\nCopie seed/situation.exemple.json vers seed/situation.local.json et adapte-le.`);
  process.exit(1);
}
const db = openDatabase(process.env.DATABASE_PATH ?? "./data/finance.db");
if (!isEmpty(db)) {
  console.error("La base contient déjà des données. Efface-les depuis la page Mémoire avant de réimporter.");
  process.exit(1);
}
const result = importSituation(db, JSON.parse(fs.readFileSync(file, "utf8")));
console.log(`Situation importée : ${result.accounts} compte(s), ${result.holdings} ligne(s) de portefeuille.`);
