/**
 * Outils de l'assistant. Chaque outil appartient à un agent spécialiste, valide ses entrées,
 * délègue tous les calculs au moteur déterministe et renvoie :
 *  - `result` : les chiffres, pour que le modèle raisonne dessus sans rien recalculer ;
 *  - `blocks` : les visualisations affichées telles quelles dans la conversation.
 */
import { z } from "zod";
import {
  CREDIT, MARKET, SAFETY, SCENARIO_LABELS, SCENARIO_NAMES, TAX, allocationAdvice, borrowingCapacity, compareRealEstateVsEtf, eur, goalPlan,
  monteCarlo, pct, projectScenarios, simulateLoan, simulateRental, stressTest, unemploymentRunway, type RentalInput,
} from "@/lib/engine";
import type { DB } from "@/lib/db/client";
import {
  PROFILE_KEYS, createDecision, createGoal, createPendingAction, listAccounts, replaceForecasts, saveSimulation, updateAccount, upsertFact, type FactStatus,
} from "@/lib/db/repo";
import { refreshAlerts } from "@/lib/monitor/alerts";
import type { AgentName, Block } from "./blocks";
import { buildContext, type FinancialContext } from "./context";
import { runSpecialists } from "./specialists";

export interface ToolOutput {
  result: unknown;
  blocks: Block[];
}

export interface ToolDef<S extends z.ZodType = z.ZodType> {
  name: string;
  agent: AgentName;
  /** Libellé affiché pendant l'exécution. */
  label: string;
  description: string;
  schema: S;
  run: (input: z.infer<S>, db: DB, ctx: FinancialContext) => ToolOutput;
}

const tool = <S extends z.ZodType>(def: ToolDef<S>): ToolDef => def as unknown as ToolDef;

const euros = z.number().finite().nonnegative().max(100_000_000);
const yearsSchema = z.number().finite().min(1).max(40);
const NOT_A_PROMISE = "Simulation, pas une prévision : aucun rendement n'est garanti.";

const rentalFields = {
  prix: euros.describe("Prix d'achat du bien, hors frais"),
  apport: euros.describe("Apport personnel"),
  loyer_mensuel: euros.describe("Loyer mensuel hors charges"),
  duree_annees: yearsSchema.describe("Horizon de détention simulé"),
  regime: z.enum(["micro_foncier", "reel", "lmnp_micro_bic"]).optional().describe("Régime fiscal ; micro_foncier par défaut"),
  taux_credit: z.number().min(0).max(0.2).optional().describe("Taux annuel du crédit, ex. 0.034"),
  duree_credit: z.number().min(5).max(25).optional(),
  vacance_mois_par_an: z.number().min(0).max(12).optional(),
  travaux: euros.optional(),
};
type RentalFields = { prix: number; apport: number; loyer_mensuel: number; duree_annees: number; regime?: "micro_foncier" | "reel" | "lmnp_micro_bic"; taux_credit?: number; duree_credit?: number; vacance_mois_par_an?: number; travaux?: number };

const toRentalInput = (i: RentalFields, ctx: FinancialContext): RentalInput => ({
  price: i.prix, downPayment: i.apport, monthlyRent: i.loyer_mensuel, years: i.duree_annees, regime: i.regime, annualRate: i.taux_credit,
  loanYears: i.duree_credit, vacancyMonthsPerYear: i.vacance_mois_par_an, works: i.travaux, marginalTaxRate: ctx.tax?.marginalRate ?? 0.3,
});

const situationKpis = (ctx: FinancialContext): Block => ({
  type: "kpis",
  title: `Situation au ${ctx.netWorth.oldestAsOf ?? ctx.date}`,
  items: [
    { label: "Patrimoine net", value: eur(ctx.netWorth.total) },
    { label: "Épargne disponible", value: eur(ctx.netWorth.liquid), hint: ctx.emergency ? `${ctx.emergency.monthsCovered.toFixed(1).replace(".", ",")} mois de dépenses${ctx.emergency.expensesAreLowerBound ? " (loyer seul)" : ""}` : undefined },
    { label: "Placements", value: eur(ctx.netWorth.invested), hint: `${pct(ctx.portfolio.riskyShareOfNetWorth)} du patrimoine` },
    { label: "Capacité d'épargne", value: ctx.budget.savingsCapacity !== null ? `${eur(ctx.budget.savingsCapacity)}/mois` : "inconnue", hint: ctx.budget.savingsCapacity === null ? "dépenses à renseigner" : undefined },
  ],
});

export const TOOLS: ToolDef[] = [
  tool({
    name: "analyser_situation",
    agent: "Patrimoine",
    label: "Analyse de la situation globale",
    description: "Synthèse complète et datée de la situation : patrimoine net, budget, épargne de précaution, portefeuille, objectifs, écarts entre prévisions passées et réalité, et constats hiérarchisés des agents spécialistes. À appeler pour toute question générale ou avant une recommandation.",
    schema: z.object({}),
    run: (_i, _db, ctx) => ({
      result: {
        patrimoine: ctx.netWorth, budget: ctx.budget, epargne_precaution: ctx.emergency, portefeuille: { total: ctx.portfolio.investedTotal, couverture_detail: ctx.portfolio.coverage, alertes: ctx.portfolio.flags },
        fiscalite: ctx.tax, objectifs: ctx.goals.map((g) => ({ titre: g.title, cible: g.targetAmount, progression: g.progress })), ecarts_previsions: ctx.forecastChecks,
        constats: runSpecialists(ctx).map((x) => ({ agent: x.agent, gravite: x.severity, nature: x.nature, titre: x.title, detail: x.detail })),
        donnees_manquantes: ctx.missing, donnees_anciennes: ctx.stale,
      },
      blocks: [situationKpis(ctx)],
    }),
  }),

  tool({
    name: "conseiller_allocation",
    agent: "Stratégie",
    label: "Comparaison des usages possibles de la somme",
    description: "Pour une somme disponible, compare quatre options chiffrées (sécurité, mixte, investissement, attente) en tenant compte de l'épargne de précaution, du portefeuille et des données manquantes. Peut recommander de ne rien investir.",
    schema: z.object({ montant: euros.min(1).describe("Somme disponible en euros") }),
    run: (i, db, ctx) => {
      const lep = ctx.accounts.find((a) => a.kind === "livret" && /lep/i.test(a.name));
      const advice = allocationAdvice({ amount: i.montant, emergency: ctx.emergency, lepBalance: lep?.balance ?? null, hasLep: !!lep, portfolioFlags: ctx.portfolio.flags, expensesKnown: ctx.otherExpenses !== null });
      saveSimulation(db, "allocation", `Que faire de ${eur(i.montant)} ?`, i, { recommandation: advice.recommendedId });
      return {
        result: advice,
        blocks: [
          { type: "options", title: `Que faire de ${eur(i.montant)} ?`, options: advice.options.map((o) => ({ title: o.title, recommended: o.recommended, split: o.split, range: o.valueIn5Years, pros: o.pros, cons: o.cons })) },
          { type: "notice", tone: "attention", title: "Incertitudes", items: advice.uncertainties },
        ],
      };
    },
  }),

  tool({
    name: "simuler_investissement",
    agent: "Bourse",
    label: "Projection d'un investissement programmé",
    description: "Projette un investissement régulier en ETF actions mondiales sur trois scénarios (prudent, central, favorable), nets de frais, d'impôts de sortie et d'inflation, avec une simulation Monte-Carlo de rendements variables. Renvoie un simulateur interactif.",
    schema: z.object({
      versement_mensuel: euros.describe("Versement mensuel en euros"),
      duree_annees: yearsSchema,
      capital_initial: euros.optional().describe("Capital de départ ; 0 par défaut"),
      enveloppe: z.enum(["PEA", "CTO"]).optional().describe("Enveloppe fiscale ; PEA par défaut"),
      cible: euros.optional().describe("Montant cible, pour estimer la probabilité de l'atteindre"),
    }),
    run: (i, db) => {
      const initial = i.capital_initial ?? 0;
      const wrapper = i.enveloppe ?? "PEA";
      const scenarios = projectScenarios({ initial, monthly: i.versement_mensuel, years: i.duree_annees, wrapper });
      const mc = monteCarlo({ initial, monthly: i.versement_mensuel, years: i.duree_annees, target: i.cible });
      const summary = Object.fromEntries(SCENARIO_NAMES.map((n) => [n, { rendement_annuel: MARKET.scenarios.value[n], valeur_brute: scenarios[n].final.value, valeur_nette_impots: scenarios[n].final.netValue, valeur_nette_euros_constants: scenarios[n].final.realNetValue }]));
      const title = `${eur(i.versement_mensuel)} par mois pendant ${i.duree_annees} ans`;
      saveSimulation(db, "investissement", title, i, summary);
      return {
        result: {
          total_verse: scenarios.central.final.contributed, scenarios: summary,
          monte_carlo: { trajectoires: mc.paths, p10: mc.final.p10, mediane: mc.final.p50, p90: mc.final.p90, probabilite_de_perte: mc.probabilityOfLoss, probabilite_cible: mc.probabilityOfTarget, baisse_maximale_mediane: mc.medianMaxDrawdown },
          hypotheses: { frais_annuels: MARKET.etfFees.value, inflation: MARKET.inflation.value, volatilite: MARKET.volatility.value, enveloppe: wrapper, avertissement: NOT_A_PROMISE },
        },
        blocks: [{ type: "projection", title, params: { initial, monthly: i.versement_mensuel, years: i.duree_annees, wrapper, wrapperAgeYears: 0 }, monteCarlo: { p10: mc.final.p10, p50: mc.final.p50, p90: mc.final.p90, probabilityOfLoss: mc.probabilityOfLoss, medianMaxDrawdown: mc.medianMaxDrawdown, paths: mc.paths } }],
      };
    },
  }),

  tool({
    name: "simuler_immobilier",
    agent: "Immobilier",
    label: "Simulation d'un investissement locatif",
    description: "Simule un achat locatif à crédit année par année : mensualité, loyers nets de vacance, charges, impôts selon le régime, trésorerie, valeur nette en cas de revente. Signale un effort d'épargne négatif.",
    schema: z.object(rentalFields),
    run: (i, db, ctx) => {
      const r = simulateRental(toRentalInput(i, ctx));
      saveSimulation(db, "immobilier", `Locatif ${eur(i.prix)}`, i, { rendement_net: r.netYield, effort_mensuel: r.averageMonthlyEffort, gain_net: r.netGain });
      return {
        result: { cout_total: r.totalCost, emprunt: r.loanPrincipal, mensualite: r.monthlyLoanPayment, rendement_brut: r.grossYield, rendement_net_de_charges: r.netYield, tresorerie_mensuelle_an1: r.firstYearMonthlyCashFlow, effort_mensuel_moyen: r.averageMonthlyEffort, patrimoine_net_final_si_revente: r.final.netEquityIfSold, gain_net: r.netGain, regime: r.regime, tmi_utilisee: ctx.tax?.marginalRate ?? 0.3, alertes: r.warnings },
        blocks: [
          { type: "kpis", title: `Locatif à ${eur(i.prix)} — ${i.duree_annees} ans`, items: [
            { label: "Coût total", value: eur(r.totalCost), hint: "frais de notaire inclus" },
            { label: "Mensualité", value: eur(r.monthlyLoanPayment), hint: `emprunt de ${eur(r.loanPrincipal)}` },
            { label: "Rendement net de charges", value: pct(r.netYield), hint: `brut ${pct(r.grossYield)}` },
            { label: "Trésorerie mensuelle (an 1)", value: eur(r.firstYearMonthlyCashFlow), hint: r.firstYearMonthlyCashFlow < 0 ? "effort d'épargne à fournir" : "après impôts" },
          ] },
          { type: "lines", title: "Patrimoine net en cas de revente", unit: "€", xLabel: "Années", series: [
            { name: "Valeur nette après revente et impôts", points: r.years.map((y) => ({ x: y.year, y: y.netEquityIfSold })) },
            { name: "Capital restant dû", points: r.years.map((y) => ({ x: y.year, y: y.remainingLoan })) },
          ], note: "Hypothèses centrales : prix +1 %/an, loyers +1,5 %/an, 1 mois de vacance par an." },
          ...(r.warnings.length > 0 ? [{ type: "notice", tone: "attention", title: "Points de vigilance", items: r.warnings } as Block] : []),
        ],
      };
    },
  }),

  tool({
    name: "comparer_immobilier_bourse",
    agent: "Stratégie",
    label: "Comparaison immobilier locatif / ETF à effort identique",
    description: "Compare, à apport et effort d'épargne identiques, l'achat d'un ou plusieurs biens locatifs à crédit et un investissement en ETF, sur trois scénarios de marché. Intègre crédit, vacance, charges, impôts, frais de revente.",
    schema: z.object({ ...rentalFields, nombre_biens: z.number().int().min(1).max(10).optional() }),
    run: (i, db, ctx) => {
      const c = compareRealEstateVsEtf({ rental: toRentalInput(i, ctx), units: i.nombre_biens ?? 1 });
      const capacity = ctx.salary !== null ? borrowingCapacity({ netMonthlyIncome: ctx.salary, existingMonthlyCharges: ctx.rent ?? 0, expectedMonthlyRent: i.loyer_mensuel * c.units }) : null;
      const feasibility: string[] = [];
      if (capacity && c.totalDebt > capacity.maxPrincipal) feasibility.push(`Dette nécessaire (${eur(c.totalDebt)}) supérieure à ta capacité d'emprunt estimée (${eur(capacity.maxPrincipal)}) : en l'état, une banque refuserait probablement ce projet.`);
      if (c.downPayment > ctx.netWorth.liquid) feasibility.push(`Apport nécessaire (${eur(c.downPayment)}) supérieur à ton épargne disponible (${eur(ctx.netWorth.liquid)}).`);
      saveSimulation(db, "comparaison", `${c.units} bien(s) locatif(s) ou ETF`, i, c.scenarios);
      const verdict = { immobilier: "Immobilier devant", etf: "ETF devant", equivalent: "Équivalent" } as const;
      return {
        result: { nombre_biens: c.units, apport_total: c.downPayment, dette_totale: c.totalDebt, effort_mensuel_moyen: c.averageMonthlyEffort, scenarios: c.scenarios, faisabilite: feasibility, capacite_emprunt_estimee: capacity?.maxPrincipal ?? null, notes: c.notes },
        blocks: [
          { type: "scenarios", title: `${c.units} bien${c.units > 1 ? "s" : ""} locatif${c.units > 1 ? "s" : ""} ou ETF, dans ${c.years} ans`, columns: ["Immobilier", "ETF"], rows: c.scenarios.map((s) => ({ scenario: s.scenario, a: s.realEstateNetWorth, b: s.etfNetWorth, verdict: verdict[s.winner] })), note: `Même apport (${eur(c.downPayment)}) et même effort mensuel moyen (${eur(c.averageMonthlyEffort)}). Patrimoine net après revente, impôts et remboursement du crédit.` },
          { type: "lines", title: "Patrimoine net — scénario central", unit: "€", xLabel: "Années", series: [
            { name: "Immobilier", points: c.series.map((p) => ({ x: p.year, y: p.immobilier })) },
            { name: "ETF", points: c.series.map((p) => ({ x: p.year, y: p.etf })) },
          ] },
          ...(feasibility.length > 0 ? [{ type: "notice", tone: "attention", title: "Faisabilité aujourd'hui", items: feasibility } as Block] : []),
          { type: "notice", tone: "info", title: "À garder en tête", items: c.notes },
        ],
      };
    },
  }),

  tool({
    name: "planifier_objectif",
    agent: "Stratégie",
    label: "Construction du plan vers l'objectif",
    description: "Calcule en combien de temps un montant de patrimoine cible peut être atteint selon le versement mensuel et les trois scénarios, et le versement nécessaire pour différents horizons. Avec enregistrer=true, mémorise l'objectif, ses hypothèses et la trajectoire prévue pour le suivi.",
    schema: z.object({
      montant_cible: euros.min(1),
      versement_mensuel: euros.optional().describe("Par défaut : la capacité d'épargne connue"),
      titre: z.string().max(120).optional(),
      enregistrer: z.boolean().optional().describe("true pour mémoriser l'objectif et suivre la progression"),
    }),
    run: (i, db, ctx) => {
      const monthly = i.versement_mensuel ?? ctx.budget.savingsCapacity ?? 0;
      const plan = goalPlan(ctx.netWorth.total, monthly, i.montant_cible);
      const blocks: Block[] = [
        { type: "table", title: `Atteindre ${eur(i.montant_cible)} avec ${eur(monthly)} par mois`, columns: ["Scénario", "Rendement simulé", "Durée estimée"], rows: [
          ["Sans aucun rendement", "0 %", plan.withoutReturnMonths !== null ? `${(plan.withoutReturnMonths / 12).toFixed(1).replace(".", ",")} ans` : "hors d'atteinte"],
          ...SCENARIO_NAMES.map((n) => [SCENARIO_LABELS[n], pct(MARKET.scenarios.value[n]), plan.byScenario[n].years !== null ? `${plan.byScenario[n].years!.toFixed(1).replace(".", ",")} ans` : "hors d'atteinte"]),
        ], note: `Point de départ : ${eur(plan.current)} de patrimoine net. ${NOT_A_PROMISE}` },
        { type: "bars", title: "Versement mensuel nécessaire selon l'échéance (scénario central)", unit: "€", items: plan.requiredMonthly.map((r) => ({ label: `${r.years} ans`, value: r.monthly })) },
      ];
      let saved = false;
      if (i.enregistrer) {
        const title = i.titre ?? `Atteindre ${eur(i.montant_cible)} de patrimoine`;
        const goal = createGoal(db, { title, targetAmount: i.montant_cible, monthlyContribution: monthly, assumptions: { patrimoineDepart: plan.current, versementMensuel: monthly, rendements: MARKET.scenarios.value, frais: MARKET.etfFees.value, salaireNetMensuel: ctx.salary, depensesMensuelles: ctx.budget.totalExpenses, date: ctx.date } }, "ia");
        const horizon = Math.min(40, Math.ceil((plan.byScenario.central.years ?? 20) + 1));
        const projection = projectScenarios({ initial: plan.current, monthly, years: horizon });
        const start = new Date(ctx.date);
        replaceForecasts(db, goal.id, SCENARIO_NAMES.flatMap((n) => projection[n].points.slice(1).map((p) => ({ date: new Date(start.getFullYear() + Math.round(p.year), start.getMonth(), start.getDate()).toISOString().slice(0, 10), scenario: n, projected: p.value }))));
        blocks.push({ type: "memory", items: [`Objectif enregistré : ${title}`, "Hypothèses et trajectoire prévue mémorisées pour le suivi"] });
        saved = true;
        refreshAlerts(db);
      }
      return { result: { plan, versement_utilise: monthly, capacite_epargne_connue: ctx.budget.savingsCapacity, objectif_enregistre: saved, avertissement: NOT_A_PROMISE }, blocks };
    },
  }),

  tool({
    name: "tester_resistance",
    agent: "Bourse",
    label: "Test de résistance du portefeuille",
    description: "Chiffre l'effet de trois chocs de marché (−20 %, −35 %, −50 %) sur les placements et le patrimoine, avec une amplification pour les actions individuelles, et le temps de récupération au rendement central.",
    schema: z.object({}),
    run: (_i, _db, ctx) => {
      const stockShare = ctx.portfolio.singleStockShare ?? (ctx.holdings.length > 0 ? ctx.holdings.filter((h) => h.assetClass === "action").length / ctx.holdings.length : null);
      const s = stressTest(ctx.accounts, stockShare);
      return {
        result: { placements: ctx.netWorth.invested, part_actions_individuelles: stockShare, amplification: s.amplification, scenarios: s.scenarios },
        blocks: [
          { type: "bars", title: "Perte estimée sur tes placements", unit: "€", items: s.scenarios.map((x) => ({ label: x.label, value: -x.loss, hint: `patrimoine restant ${eur(x.netWorthAfter)} · ≈ ${x.recoveryYears.toFixed(1).replace(".", ",")} ans pour récupérer` })), note: `Chocs amplifiés de ×${s.amplification.toFixed(2).replace(".", ",")} car le portefeuille contient surtout des actions individuelles, plus volatiles qu'un indice. Récupération estimée au rendement central, sans nouveau versement.` },
        ],
      };
    },
  }),

  tool({
    name: "simuler_perte_emploi",
    agent: "Budget",
    label: "Simulation d'une perte d'emploi",
    description: "Calcule combien de temps les liquidités (puis les placements, décotés) permettent de tenir en cas de perte d'emploi, avec et sans allocation chômage estimée.",
    schema: z.object({ duree_mois: z.number().min(1).max(36), depenses_mensuelles: euros.optional().describe("À fournir si les dépenses ne sont pas en mémoire") }),
    run: (i, _db, ctx) => {
      const known = ctx.budget.totalExpenses;
      const expenses = i.depenses_mensuelles ?? known ?? ctx.budget.knownExpenses;
      if (!expenses || ctx.salary === null) return { result: { erreur: "Dépenses mensuelles ou salaire inconnus : simulation impossible." }, blocks: [] };
      const r = unemploymentRunway({ liquid: ctx.netWorth.liquid, invested: ctx.netWorth.invested, monthlyExpenses: expenses, netMonthlyIncome: ctx.salary, months: i.duree_mois });
      const fmt = (m: number | null) => (m === null ? "indéfiniment" : `${m.toFixed(1).replace(".", ",")} mois`);
      const partial = i.depenses_mensuelles === undefined && known === null;
      return {
        result: { depenses_utilisees: expenses, depenses_incompletes: partial, cas: r.cases, decote_placements: r.haircut, taux_remplacement_chomage: SAFETY.unemploymentReplacement.value },
        blocks: [
          { type: "table", title: `Sans emploi pendant ${i.duree_mois} mois`, columns: ["Hypothèse", "Revenu mensuel", "Manque mensuel", "Tenue avec les liquidités", "En vendant aussi les placements"], rows: r.cases.map((c) => [c.label, eur(c.monthlyIncome), eur(c.monthlyShortfall), fmt(c.monthsOnLiquid), fmt(c.monthsWithInvestments)]), note: `Dépenses retenues : ${eur(expenses)} par mois${partial ? " — loyer seul, donc résultat trop optimiste" : ""}. Placements décotés de ${pct(r.haircut)} (vente forcée en marché baissier). Allocation estimée à ${pct(SAFETY.unemploymentReplacement.value)} du salaire net, hors délais de carence.` },
        ],
      };
    },
  }),

  tool({
    name: "calculer_capacite_emprunt",
    agent: "Immobilier",
    label: "Calcul de la capacité d'emprunt",
    description: "Capacité d'emprunt immobilier selon la règle des 35 % d'endettement, en restant locataire, avec prise en compte pondérée des loyers attendus.",
    schema: z.object({ loyer_attendu: euros.optional(), taux: z.number().min(0).max(0.2).optional(), duree_annees: z.number().min(5).max(25).optional() }),
    run: (i, _db, ctx) => {
      if (ctx.salary === null) return { result: { erreur: "Salaire inconnu." }, blocks: [] };
      const c = borrowingCapacity({ netMonthlyIncome: ctx.salary, existingMonthlyCharges: ctx.rent ?? 0, expectedMonthlyRent: i.loyer_attendu, annualRate: i.taux, years: i.duree_annees });
      return {
        result: c,
        blocks: [{ type: "kpis", title: "Capacité d'emprunt estimée", items: [
          { label: "Capital empruntable", value: eur(c.maxPrincipal), hint: `sur ${c.assumptions.years} ans à ${pct(c.assumptions.annualRate)}` },
          { label: "Mensualité maximale", value: eur(c.maxMonthlyPayment), hint: "assurance incluse" },
          { label: "Revenus retenus", value: eur(c.consideredIncome), hint: i.loyer_attendu ? `loyers comptés à ${pct(c.assumptions.rentalIncomeWeight)}` : "salaire seul" },
        ] }],
      };
    },
  }),

  tool({
    name: "tableau_amortissement",
    agent: "Immobilier",
    label: "Tableau de remboursement",
    description: "Tableau d'amortissement annuel d'un prêt à taux fixe : mensualité, intérêts, capital remboursé, capital restant dû, coût total.",
    schema: z.object({ capital: euros.min(1), taux: z.number().min(0).max(0.2).describe("Taux annuel, ex. 0.034"), duree_annees: z.number().min(1).max(30), taux_assurance: z.number().min(0).max(0.02).optional() }),
    run: (i) => {
      const l = simulateLoan({ principal: i.capital, annualRate: i.taux, years: i.duree_annees, insuranceRate: i.taux_assurance ?? CREDIT.insuranceRate.value });
      return {
        result: { mensualite_totale: l.monthlyTotal, total_interets: l.totalInterest, total_assurance: l.totalInsurance, cout_total: l.totalCost },
        blocks: [
          { type: "kpis", title: `Prêt de ${eur(i.capital)} sur ${i.duree_annees} ans à ${pct(i.taux)}`, items: [
            { label: "Mensualité", value: eur(l.monthlyTotal), hint: `dont assurance ${eur(l.monthlyInsurance)}` },
            { label: "Intérêts", value: eur(l.totalInterest) },
            { label: "Coût total du crédit", value: eur(l.totalCost), hint: "intérêts + assurance" },
          ] },
          { type: "table", title: "Tableau de remboursement", columns: ["Année", "Intérêts", "Capital remboursé", "Restant dû"], rows: l.schedule.map((y) => [y.year, eur(y.interest), eur(y.principalRepaid), eur(y.remaining)]) },
        ],
      };
    },
  }),

  tool({
    name: "analyser_portefeuille",
    agent: "Bourse",
    label: "Analyse du portefeuille",
    description: "Répartition des placements par compte, par ligne et par secteur, niveau de concentration, part connue de la composition. Ne fournit aucun cours : uniquement les valeurs saisies ou importées, avec leur date.",
    schema: z.object({}),
    run: (_i, _db, ctx) => {
      const p = ctx.portfolio;
      const blocks: Block[] = [{ type: "bars", title: "Placements par compte", unit: "€", items: p.byAccount.map((a) => ({ label: a.label, value: a.value, hint: pct(a.weight) })) }];
      if (p.lines.length > 0) blocks.push({ type: "bars", title: "Lignes valorisées", unit: "€", items: p.lines.slice(0, 12).map((l) => ({ label: l.name, value: l.value, hint: pct(l.weight) })) });
      const notes = [...p.flags];
      if (p.holdingsWithoutValue.length > 0) notes.push(`Titres identifiés sans valeur renseignée : ${p.holdingsWithoutValue.join(", ")}.`);
      if (notes.length > 0) blocks.push({ type: "notice", tone: "attention", title: "Limites de l'analyse", items: notes });
      return { result: { total: p.investedTotal, par_compte: p.byAccount, lignes: p.lines, par_secteur: p.bySector, part_detaillee: p.coverage, titres_sans_valeur: p.holdingsWithoutValue, indice_concentration: p.concentrationIndex, alertes: p.flags, taxation_cto: TAX.pfuIR.value + TAX.psCapital.value }, blocks };
    },
  }),

  tool({
    name: "analyser_depenses",
    agent: "Budget",
    label: "Analyse des dépenses",
    description: "Dépenses moyennes par catégorie observées sur les relevés importés (mois complets), comparées au budget déclaré.",
    schema: z.object({}),
    run: (_i, _db, ctx) => {
      const o = ctx.observedSpending;
      if (!o) return { result: { erreur: "Aucun relevé importé sur un mois complet. Les dépenses ne peuvent pas être analysées.", depenses_declarees: ctx.otherExpenses }, blocks: [{ type: "notice", tone: "info", title: "Pas encore de relevés", items: ["Importe un relevé CSV depuis la page Budget, ou indique-moi tes dépenses mensuelles approximatives."] }] };
      return { result: { observe: o, declare_hors_loyer: ctx.otherExpenses, budget: ctx.budget }, blocks: [{ type: "bars", title: `Dépenses moyennes par mois (${o.from} → ${o.to})`, unit: "€", items: o.byCategory.map((c) => ({ label: c.category, value: c.averageMonthly })), note: `Total observé : ${eur(o.averageMonthly)} par mois sur ${o.months} mois complet(s).` }] };
    },
  }),

  tool({
    name: "mettre_a_jour_profil",
    agent: "Patrimoine",
    label: "Mise à jour de la mémoire financière",
    description: "Enregistre dans la mémoire une information de profil que l'utilisateur vient de donner : salaire, loyer, autres dépenses, tolérance au risque, horizon, parts fiscales. N'utiliser que pour des informations explicitement fournies par l'utilisateur ; statut 'estime' s'il a donné un ordre de grandeur.",
    schema: z.object({
      salaire_net_mensuel: euros.optional(), loyer_mensuel: euros.optional(), autres_depenses_mensuelles: euros.optional().describe("Dépenses mensuelles hors loyer"),
      tolerance_risque: z.string().max(200).optional(), horizon_annees: z.number().min(1).max(60).optional(), parts_fiscales: z.number().min(1).max(10).optional(),
      statut: z.enum(["verifie", "estime"]).optional(),
    }),
    run: (i, db) => {
      const status: FactStatus = i.statut ?? "estime";
      const saved: string[] = [];
      const num = (def: { key: string; category: string; label: string }, v: number | undefined, unit = " €") => {
        if (v === undefined) return;
        upsertFact(db, { ...def, value: String(v), numericValue: v, status, source: "conversation" }, "ia");
        saved.push(`${def.label} : ${v}${unit}`);
      };
      num(PROFILE_KEYS.salary, i.salaire_net_mensuel);
      num(PROFILE_KEYS.rent, i.loyer_mensuel);
      num(PROFILE_KEYS.otherExpenses, i.autres_depenses_mensuelles);
      num(PROFILE_KEYS.horizon, i.horizon_annees, " ans");
      num(PROFILE_KEYS.taxParts, i.parts_fiscales, "");
      if (i.tolerance_risque) {
        upsertFact(db, { ...PROFILE_KEYS.riskTolerance, value: i.tolerance_risque, status, source: "conversation" }, "ia");
        saved.push(`Tolérance au risque : ${i.tolerance_risque}`);
      }
      const ctx = buildContext(db);
      refreshAlerts(db, ctx);
      return { result: { enregistre: saved, nouvelle_capacite_epargne: ctx.budget.savingsCapacity, epargne_precaution: ctx.emergency }, blocks: saved.length > 0 ? [{ type: "memory", items: saved }] : [] };
    },
  }),

  tool({
    name: "memoriser",
    agent: "Patrimoine",
    label: "Mémorisation",
    description: "Mémorise durablement une information financière utile qui n'entre pas dans le profil standard : projet futur, préférence, contrainte, événement attendu (prime, déménagement), date d'ouverture d'une enveloppe. Une clé stable par information (ex. 'projet.achat_voiture', 'fiscal.pea_date_ouverture').",
    schema: z.object({
      cle: z.string().regex(/^[a-z_]+\.[a-z0-9_]+$/).max(80), categorie: z.enum(["revenu", "charge", "profil", "fiscal", "projet", "objectif", "preference", "autre"]),
      libelle: z.string().min(2).max(120), valeur: z.string().min(1).max(500), valeur_numerique: z.number().finite().optional(), statut: z.enum(["verifie", "estime"]),
    }),
    run: (i, db) => {
      upsertFact(db, { key: i.cle, category: i.categorie, label: i.libelle, value: i.valeur, numericValue: i.valeur_numerique ?? null, status: i.statut, source: "conversation" }, "ia");
      refreshAlerts(db);
      return { result: { enregistre: true }, blocks: [{ type: "memory", items: [`${i.libelle} : ${i.valeur}`] }] };
    },
  }),

  tool({
    name: "mettre_a_jour_solde",
    agent: "Patrimoine",
    label: "Mise à jour d'un solde",
    description: "Met à jour le solde d'un compte existant quand l'utilisateur communique un nouveau montant. C'est une écriture dans le suivi interne, pas une opération bancaire.",
    schema: z.object({ nom_compte: z.string().min(2).max(120), solde: z.number().finite() }),
    run: (i, db) => {
      const needle = i.nom_compte.toLowerCase();
      const matches = listAccounts(db).filter((a) => a.name.toLowerCase().includes(needle) || needle.includes(a.name.toLowerCase()));
      if (matches.length !== 1) return { result: { erreur: matches.length === 0 ? "Aucun compte ne correspond." : "Plusieurs comptes correspondent : préciser.", comptes: listAccounts(db).map((a) => a.name) }, blocks: [] };
      const before = matches[0]!.balance;
      const account = updateAccount(db, matches[0]!.id, { balance: i.solde, source: "conversation" }, "ia")!;
      const ctx = buildContext(db);
      refreshAlerts(db, ctx);
      return { result: { compte: account.name, ancien_solde: before, nouveau_solde: account.balance, patrimoine_net: ctx.netWorth.total }, blocks: [{ type: "memory", items: [`${account.name} : ${eur(before)} → ${eur(account.balance)}`] }] };
    },
  }),

  tool({
    name: "enregistrer_decision",
    agent: "Stratégie",
    label: "Enregistrement de la décision",
    description: "Consigne une décision financière prise par l'utilisateur, avec les hypothèses sur lesquelles elle repose, pour pouvoir la réexaminer si elles changent.",
    schema: z.object({ titre: z.string().min(3).max(140), detail: z.string().min(3).max(1000) }),
    run: (i, db, ctx) => {
      createDecision(db, { title: i.titre, detail: i.detail, assumptions: { salaireNetMensuel: ctx.salary, depensesMensuelles: ctx.budget.totalExpenses, patrimoineNet: ctx.netWorth.total, date: ctx.date } }, "ia");
      return { result: { enregistre: true }, blocks: [{ type: "memory", items: [`Décision consignée : ${i.titre}`] }] };
    },
  }),

  tool({
    name: "preparer_operation",
    agent: "Stratégie",
    label: "Préparation d'une opération (sans exécution)",
    description: "Prépare la fiche d'une opération financière (achat, vente, virement, souscription) avec ses paramètres exacts, pour validation par l'utilisateur. Cet outil N'EXÉCUTE RIEN : aucune connexion bancaire n'existe. L'utilisateur confirme puis réalise lui-même l'opération chez sa banque ou son courtier.",
    schema: z.object({
      type: z.enum(["achat", "vente", "virement", "souscription"]), montant: euros.min(0.01), support: z.string().max(120).optional().describe("Titre ou produit concerné"),
      compte_source: z.string().max(120).optional(), compte_destination: z.string().max(120).optional(), motif: z.string().max(300),
    }),
    run: (i, db) => {
      const title = `${i.type[0]!.toUpperCase()}${i.type.slice(1)} de ${eur(i.montant)}${i.support ? ` — ${i.support}` : ""}`;
      const action = createPendingAction(db, i.type, title, i);
      const params = [
        { label: "Type", value: i.type }, { label: "Montant", value: eur(i.montant) },
        ...(i.support ? [{ label: "Support", value: i.support }] : []), ...(i.compte_source ? [{ label: "Depuis", value: i.compte_source }] : []),
        ...(i.compte_destination ? [{ label: "Vers", value: i.compte_destination }] : []), { label: "Motif", value: i.motif },
      ];
      return { result: { operation_preparee: action.id, statut: "en attente de confirmation explicite de l'utilisateur", execution: "aucune — à réaliser par l'utilisateur chez son établissement" }, blocks: [{ type: "action", actionId: action.id, title, params, status: "preparee" }] };
    },
  }),
];

export const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** Exécute un outil après validation stricte de ses entrées. Toute erreur est renvoyée au modèle, jamais masquée. */
export function executeTool(name: string, rawInput: unknown, db: DB): ToolOutput & { ok: boolean; agent: AgentName; label: string } {
  const def = TOOL_BY_NAME.get(name);
  if (!def) return { ok: false, agent: "Patrimoine", label: name, result: { erreur: `Outil inconnu : ${name}` }, blocks: [] };
  const parsed = def.schema.safeParse(rawInput ?? {});
  if (!parsed.success) return { ok: false, agent: def.agent, label: def.label, result: { erreur: "Paramètres invalides", details: parsed.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`) }, blocks: [] };
  try {
    const out = def.run(parsed.data, db, buildContext(db));
    return { ok: true, agent: def.agent, label: def.label, ...out };
  } catch (error) {
    return { ok: false, agent: def.agent, label: def.label, result: { erreur: error instanceof Error ? error.message : "Erreur de calcul" }, blocks: [] };
  }
}
