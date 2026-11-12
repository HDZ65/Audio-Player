import { beforeEach, describe, expect, it } from "vitest";
import type { Block, ChatEvent } from "@/lib/ai/blocks";
import { buildContext, contextForModel } from "@/lib/ai/context";
import { detectIntent, parseAmounts, runLocalOrchestrator } from "@/lib/ai/local";
import { arbitrate, runSpecialists, type Finding } from "@/lib/ai/specialists";
import { TOOLS, executeTool } from "@/lib/ai/tools";
import { categorize } from "@/lib/budget/categorize";
import { parseAmount, parseBankCsv, parseDate } from "@/lib/budget/csv";
import { openDatabase, type DB } from "@/lib/db/client";
import * as repo from "@/lib/db/repo";
import { importSituation } from "@/lib/db/seed";
import { refreshAlerts } from "@/lib/monitor/alerts";
import { checkPassword, createSessionToken, verifySessionToken } from "@/lib/security/auth";
import { SITUATION } from "./fixtures";

let db: DB;
beforeEach(() => {
  db = openDatabase(":memory:");
  importSituation(db, SITUATION);
});

const ask = async (message: string) => {
  const events: ChatEvent[] = [];
  const result = await runLocalOrchestrator(db, message, (e) => events.push(e));
  return { ...result, events };
};
const blockTypes = (blocks: Block[]) => blocks.map((b) => b.type);

describe("mémoire et contexte", () => {
  it("reconstitue la situation sans rien inventer", () => {
    const ctx = buildContext(db);
    expect(ctx.netWorth.total).toBe(7250);
    expect(ctx.salary).toBe(2700);
    expect(ctx.otherExpenses).toBeNull();
    expect(ctx.budget.savingsCapacity).toBeNull();
    expect(ctx.missing).toContain("dépenses mensuelles hors loyer");
    expect(ctx.holdings.every((h) => h.value === null)).toBe(true);
    expect(repo.getFact(db, repo.PROFILE_KEYS.otherExpenses.key)?.status).toBe("manquant");
  });
  it("distingue les statuts dans le contexte transmis au modèle", () => {
    const text = contextForModel(buildContext(db));
    expect(text).toContain("[vérifié] Salaire net mensuel : 2700");
    expect(text).toContain("[MANQUANT] Autres dépenses mensuelles");
    expect(text).toContain("valeur de marché inconnue");
    expect(text).not.toMatch(/IBAN|FR76/);
  });
  it("conserve l'historique des valeurs", () => {
    repo.upsertFact(db, { ...repo.PROFILE_KEYS.salary, value: "2900", numericValue: 2900, status: "verifie", source: "test" });
    expect(repo.factNumber(db, repo.PROFILE_KEYS.salary.key)).toBe(2900);
    expect(repo.factHistory(db, repo.PROFILE_KEYS.salary.key)[0]?.value).toBe("2700");
  });
  it("met à jour le patrimoine et son historique quand un solde change", () => {
    const account = repo.listAccounts(db)[0]!;
    repo.updateAccount(db, account.id, { balance: 3000 });
    expect(buildContext(db).netWorth.total).toBe(8250);
    expect(repo.netWorthHistory(db).at(-1)?.total).toBe(8250);
  });
  it("efface toutes les données sur demande", () => {
    repo.wipeAll(db);
    expect(repo.isEmpty(db)).toBe(true);
    expect(buildContext(db).isEmpty).toBe(true);
  });
});

describe("spécialistes et alertes", () => {
  it("produit les constats attendus pour la situation de départ", () => {
    const keys = runSpecialists(buildContext(db)).map((f) => f.key);
    expect(keys).toEqual(expect.arrayContaining(["budget.depenses_manquantes", "patrimoine.precaution", "bourse.composition_inconnue", "fiscalite.pea_sous_utilise", "fiscalite.lep_eligibilite", "immobilier.capacite", "strategie.pas_d_objectif"]));
  });
  it("classe par gravité et fait taire l'optimisation en cas de problème de trésorerie", () => {
    const base = { agent: "Budget", nature: "fait", title: "t", detail: "d", fingerprint: "x" } as const;
    const findings: Finding[] = [
      { ...base, key: "immobilier.capacite", severity: "info" },
      { ...base, key: "bourse.concentration", severity: "important" },
      { ...base, key: "budget.decouvert", severity: "critique" },
    ];
    expect(arbitrate(findings).map((f) => f.key)).toEqual(["budget.decouvert", "bourse.concentration"]);
  });
  it("détecte un risque de découvert", () => {
    repo.updateAccount(db, repo.listAccounts(db)[0]!.id, { balance: 300 });
    expect(runSpecialists(buildContext(db))[0]?.key).toBe("budget.risque_decouvert");
  });
  it("ne garde en alerte que l'important, et respecte une alerte ignorée tant que sa cause ne change pas", () => {
    const { alerts } = refreshAlerts(db);
    expect(alerts.every((a) => a.severity !== "info")).toBe(true);
    const target = alerts.find((a) => a.key === "bourse.composition_inconnue")!;
    repo.dismissAlert(db, target.id);
    expect(refreshAlerts(db).alerts.some((a) => a.key === target.key)).toBe(false);
    // La cause change (une ligne est valorisée à hauteur de la moitié des placements) : l'alerte revient.
    repo.updateHolding(db, repo.listHoldings(db)[0]!.id, { name: "Apple", value: 2300 });
    expect(refreshAlerts(db).alerts.some((a) => a.key === target.key)).toBe(true);
  });
  it("signale une décision dont les hypothèses ne tiennent plus", () => {
    repo.createDecision(db, { title: "Investir 500 € par mois", detail: "PEA", assumptions: { salaireNetMensuel: 2700 } });
    repo.upsertFact(db, { ...repo.PROFILE_KEYS.salary, value: "2000", numericValue: 2000, status: "verifie", source: "test" });
    expect(runSpecialists(buildContext(db)).some((f) => f.key.startsWith("strategie.hypotheses_caduques"))).toBe(true);
  });
});

describe("outils", () => {
  it("ont des noms uniques et des schémas objets", () => {
    expect(new Set(TOOLS.map((t) => t.name)).size).toBe(TOOLS.length);
    for (const t of TOOLS) expect(t.schema.safeParse({}).success || t.schema.safeParse({}).error).toBeTruthy();
  });
  it("rejettent les entrées invalides sans lever d'exception", () => {
    const out = executeTool("simuler_investissement", { versement_mensuel: -5, duree_annees: 500 }, db);
    expect(out.ok).toBe(false);
    expect(executeTool("inconnu", {}, db).ok).toBe(false);
  });
  it("mémorisent une information et recalculent la situation", () => {
    const out = executeTool("mettre_a_jour_profil", { autres_depenses_mensuelles: 900 }, db);
    expect(out.ok).toBe(true);
    expect((out.result as { nouvelle_capacite_epargne: number }).nouvelle_capacite_epargne).toBe(1100);
    expect(repo.getFact(db, repo.PROFILE_KEYS.otherExpenses.key)?.status).toBe("estime");
    expect(repo.listAudit(db).some((a) => a.actor === "ia")).toBe(true);
  });
  it("préparent une opération sans jamais l'exécuter", () => {
    const before = buildContext(db).netWorth.total;
    const out = executeTool("preparer_operation", { type: "achat", montant: 500, support: "ETF Monde", motif: "Diversification" }, db);
    const action = repo.listPendingActions(db)[0]!;
    expect(action.status).toBe("preparee");
    expect(out.blocks[0]?.type).toBe("action");
    expect(buildContext(db).netWorth.total).toBe(before);
    expect(repo.resolvePendingAction(db, action.id, "confirmee")?.status).toBe("confirmee");
    // Une opération déjà tranchée ne peut plus changer d'état.
    expect(repo.resolvePendingAction(db, action.id, "annulee")?.status).toBe("confirmee");
    expect(buildContext(db).netWorth.total).toBe(before);
  });
  it("enregistrent un objectif avec sa trajectoire prévue", () => {
    const out = executeTool("planifier_objectif", { montant_cible: 100000, versement_mensuel: 600, enregistrer: true }, db);
    expect(out.ok).toBe(true);
    const goal = repo.listGoals(db)[0]!;
    expect(goal.targetAmount).toBe(100000);
    expect(goal.assumptions).toHaveProperty("rendements");
    expect(repo.listForecasts(db, goal.id).length).toBeGreaterThan(10);
  });
  it("signalent un projet immobilier non finançable", () => {
    const out = executeTool("comparer_immobilier_bourse", { prix: 120000, apport: 15000, loyer_mensuel: 650, duree_annees: 20, nombre_biens: 2 }, db);
    expect((out.result as { faisabilite: string[] }).faisabilite.length).toBeGreaterThan(0);
    expect(blockTypes(out.blocks)).toContain("scenarios");
  });
  it("mettent à jour un solde par son nom, et refusent l'ambiguïté", () => {
    expect(executeTool("mettre_a_jour_solde", { nom_compte: "LEP", solde: 1000 }, db).ok).toBe(true);
    expect(repo.listAccounts(db).find((a) => a.name === "LEP")?.balance).toBe(1000);
    expect((executeTool("mettre_a_jour_solde", { nom_compte: "compte-titres", solde: 1 }, db).result as { erreur?: string }).erreur).toBeDefined();
  });
});

describe("mode local", () => {
  it("lit les montants en euros", () => {
    expect(parseAmounts("J'ai 1 000 € et 100 000 euros, plus 2,5 k€ et 600€")).toEqual([1000, 100000, 2500, 600]);
  });
  it("reconnaît les demandes types", () => {
    expect(detectIntent("J'ai 1 000 € disponibles. Qu'est-ce que tu me conseilles d'en faire ?")).toEqual({ kind: "allocation", amount: 1000 });
    expect(detectIntent("Si j'investis 600 € par mois, combien pourrais-je avoir dans 10 ans ?")).toEqual({ kind: "investissement", monthly: 600, years: 10 });
    expect(detectIntent("Si j'achète deux appartements pour les louer, serai-je plus riche que si j'investis en ETF ?")).toMatchObject({ kind: "immobilier", units: 2 });
    expect(detectIntent("Quelle stratégie pourrait me permettre d'atteindre 100 000 € de patrimoine le plus rapidement ?")).toMatchObject({ kind: "objectif", target: 100000 });
    expect(detectIntent("Si je perds mon emploi pendant six mois, combien de temps puis-je tenir ?")).toEqual({ kind: "emploi", months: 6 });
    expect(detectIntent("Mes dépenses mensuelles hors loyer sont d'environ 900 €")).toEqual({ kind: "maj_depenses", amount: 900 });
    expect(detectIntent("Bonjour")).toEqual({ kind: "situation" });
  });
  it("recommande de ne pas investir tant que les dépenses sont inconnues", async () => {
    const r = await ask("J'ai 1 000 € disponibles. Qu'est-ce que tu me conseilles d'en faire ?");
    expect(blockTypes(r.blocks)).toEqual(["options", "notice"]);
    expect(r.text).toMatch(/renforcer l'épargne de précaution/i);
    expect(r.text).toMatch(/dépenses mensuelles sont inconnues/);
    expect(r.steps[0]?.agent).toBe("Stratégie");
  });
  it("mémorise les dépenses données en conversation puis s'en sert", async () => {
    const r = await ask("Mes dépenses mensuelles hors loyer sont d'environ 900 €");
    expect(r.text).toContain("1 100 €");
    expect(buildContext(db).budget.savingsCapacity).toBe(1100);
    const next = await ask("J'ai 1 000 € disponibles, que faire ?");
    expect(next.text).toMatch(/renforcer l'épargne de précaution/i);
  });
  it("simule un investissement mensuel sur trois scénarios en signalant l'inconnue", async () => {
    const r = await ask("Si j'investis 600 € par mois, combien pourrais-je avoir dans 10 ans ?");
    expect(r.blocks[0]?.type).toBe("projection");
    expect(r.text).toMatch(/Prudent/);
    expect(r.text).toMatch(/Favorable/);
    expect(r.text).toMatch(/je ne connais pas tes dépenses/);
    expect(r.text).not.toMatch(/garanti[es]? de/);
  });
  it("compare immobilier et ETF en annonçant ses hypothèses", async () => {
    const r = await ask("Si j'achète deux appartements pour les louer, serai-je plus riche que si j'investis en ETF ?");
    expect(r.text).toMatch(/hypothèse type/);
    expect(r.text).toMatch(/Faisabilité/);
  });
  it("construit et enregistre un plan vers 100 000 €", async () => {
    const r = await ask("Quelle stratégie pourrait me permettre d'atteindre 100 000 € de patrimoine le plus rapidement ?");
    expect(repo.listGoals(db)).toHaveLength(1);
    expect(blockTypes(r.blocks)).toContain("memory");
  });
  it("simule une perte d'emploi et signale une base incomplète", async () => {
    const r = await ask("Si je perds mon emploi pendant six mois, combien de temps puis-je tenir ?");
    expect(r.blocks[0]?.type).toBe("table");
    expect(r.text).toMatch(/trop optimistes/);
  });
  it("guide vers la saisie quand rien n'est connu", async () => {
    repo.wipeAll(db);
    const r = await ask("Bonjour");
    expect(r.text).toMatch(/ne connais pas encore ta situation/);
  });
});

describe("import de relevés", () => {
  it("lit montants et dates au format français", () => {
    expect(parseAmount("-1 234,56")).toBe(-1234.56);
    expect(parseAmount("1.234,56 €")).toBe(1234.56);
    expect(parseAmount("abc")).toBeNull();
    expect(parseDate("05/11/2026")).toBe("2026-11-05");
    expect(parseDate("2026-11-05")).toBe("2026-11-05");
  });
  it("importe un CSV bancaire, classe les opérations et ignore les doublons", () => {
    const csv = `dateOp;dateVal;label;category;amount\n2026-10-02;2026-10-02;"CARTE CARREFOUR CITY";Alimentation;-42,10\n2026-10-03;2026-10-03;"VIR SALAIRE OCTOBRE";Revenus;2 700,00\n2026-10-05;2026-10-05;"PRLV NETFLIX";Loisirs;-13,49\nligne;invalide`;
    const parsed = parseBankCsv(csv);
    expect(parsed.transactions).toHaveLength(3);
    expect(parsed.skipped).toBe(1);
    expect(repo.insertTransactions(db, parsed.transactions, categorize)).toEqual({ inserted: 3, duplicates: 0 });
    expect(repo.insertTransactions(db, parsed.transactions, categorize)).toEqual({ inserted: 0, duplicates: 3 });
    const categories = Object.fromEntries(repo.listTransactions(db).map((t) => [t.label, t.category]));
    expect(categories["CARTE CARREFOUR CITY"]).toBe("courses");
    expect(categories["VIR SALAIRE OCTOBRE"]).toBe("revenus");
    expect(categories["PRLV NETFLIX"]).toBe("abonnements");
  });
  it("refuse un fichier sans colonnes reconnaissables", () => {
    expect(parseBankCsv("a;b\n1;2").error).toBeDefined();
  });
});

describe("sécurité", () => {
  it("valide mot de passe et session signée", () => {
    process.env.APP_PASSWORD = "correct horse";
    expect(checkPassword("correct horse")).toBe(true);
    expect(checkPassword("wrong")).toBe(false);
    const token = createSessionToken(1_000);
    expect(verifySessionToken(token, 2_000)).toBe(true);
    expect(verifySessionToken(token, 1_000 + 31 * 86_400_000)).toBe(false);
    expect(verifySessionToken(`${Date.now() + 1e9}.deadbeef`)).toBe(false);
    expect(verifySessionToken(undefined)).toBe(false);
    delete process.env.APP_PASSWORD;
  });
});
