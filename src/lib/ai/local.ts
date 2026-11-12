/**
 * Orchestrateur local : utilisé quand aucun modèle n'est configuré (ou en secours).
 * Il reconnaît les demandes courantes par règles, appelle exactement les mêmes outils
 * déterministes que le modèle et rédige la réponse à partir de gabarits. Moins souple
 * qu'un modèle, mais les chiffres sont identiques et rien ne quitte la machine.
 */
import { MARKET, SAFETY, SCENARIO_LABELS, SCENARIO_NAMES, TAX, eur, pct, type AllocationAdvice, type GoalPlan } from "@/lib/engine";
import type { DB } from "@/lib/db/client";
import type { Block, ChatEvent, Step } from "./blocks";
import { buildContext, type FinancialContext } from "./context";
import type { OrchestratorResult } from "./orchestrator";
import { runSpecialists } from "./specialists";
import { executeTool } from "./tools";

const WORD_NUMBERS: Record<string, number> = { un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9, dix: 10, douze: 12, quinze: 15, vingt: 20 };

const norm = (s: string): string => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/** Extrait les montants en euros d'une phrase (« 1 000 € », « 100k », « 2,5 k€ »). */
export function parseAmounts(text: string): number[] {
  const out: number[] = [];
  const re = /(\d{1,3}(?:[   .]\d{3})+|\d+)(?:,(\d+))?\s*(k|m)?\s*(?:€|euros?|eur\b|k€)/gi;
  for (const m of text.matchAll(re)) {
    let n = Number(m[1]!.replace(/[   .]/g, "") + (m[2] ? `.${m[2]}` : ""));
    const suffix = (m[3] ?? "").toLowerCase();
    if (suffix === "k" || /k€/i.test(m[0])) n *= 1000;
    if (suffix === "m") n *= 1_000_000;
    out.push(n);
  }
  return out;
}

function parseCount(text: string, unit: RegExp): number | null {
  const m = norm(text).match(new RegExp(`(\\d+|${Object.keys(WORD_NUMBERS).join("|")})\\s+(?:${unit.source})`));
  if (!m) return null;
  return /^\d+$/.test(m[1]!) ? Number(m[1]) : (WORD_NUMBERS[m[1]!] ?? null);
}

export type Intent =
  | { kind: "maj_depenses"; amount: number }
  | { kind: "maj_salaire"; amount: number }
  | { kind: "allocation"; amount: number }
  | { kind: "investissement"; monthly: number; years: number }
  | { kind: "immobilier"; units: number; years: number }
  | { kind: "objectif"; target: number; monthly: number | null }
  | { kind: "emploi"; months: number }
  | { kind: "resistance" }
  | { kind: "portefeuille" }
  | { kind: "depenses" }
  | { kind: "emprunt" }
  | { kind: "amortissement"; capital: number; rate: number; years: number }
  | { kind: "precaution" }
  | { kind: "situation" };

export function detectIntent(message: string): Intent {
  const t = norm(message);
  const amounts = parseAmounts(message);
  const years = parseCount(message, /ans?|annees?/);
  const hypothetical = /\bsi\b|\bet si\b|combien/.test(t);

  if (/tableau|amortissement|remboursement/.test(t) && amounts.length > 0) {
    const rate = t.match(/(\d+(?:[.,]\d+)?)\s*%/);
    return { kind: "amortissement", capital: Math.max(...amounts), rate: rate ? Number(rate[1]!.replace(",", ".")) / 100 : 0.034, years: years ?? 20 };
  }
  if (/emploi|chomage|licenci|sans revenu/.test(t)) return { kind: "emploi", months: parseCount(message, /mois/) ?? 6 };
  if (/appartement|immobilier|locatif|studio|\blouer\b/.test(t)) return { kind: "immobilier", units: parseCount(message, /appartements?|biens?|studios?|logements?/) ?? 1, years: years ?? 20 };
  if (/par mois|mensuel|chaque mois/.test(t) && /invest|plac|vers|epargn/.test(t) && amounts.length > 0 && !/atteindre/.test(t)) return { kind: "investissement", monthly: amounts[0]!, years: years ?? 10 };
  if (/atteindre|objectif|viser/.test(t) && amounts.length > 0) {
    const target = Math.max(...amounts);
    const monthly = /par mois|mensuel/.test(t) && amounts.length > 1 ? Math.min(...amounts) : null;
    return { kind: "objectif", target, monthly };
  }
  if (!hypothetical && /depenses?/.test(t) && amounts.length > 0 && /sont|est|environ|depense|autour|a peu pres/.test(t)) return { kind: "maj_depenses", amount: amounts[0]! };
  if (!hypothetical && /salaire|je gagne|revenu/.test(t) && amounts.length > 0 && /maintenant|desormais|passe|est de|augment|je gagne/.test(t)) return { kind: "maj_salaire", amount: amounts[0]! };
  if (amounts.length > 0 && /disponible|de cote|a placer|quoi faire|qu'est-ce que|que faire|conseill|investir|placer/.test(t)) return { kind: "allocation", amount: amounts[0]! };
  if (/resistance|krach|crise|stress|chute|baisse des marches/.test(t)) return { kind: "resistance" };
  if (/portefeuille|diversif|concentr|mes actions|mes placements|mes lignes/.test(t)) return { kind: "portefeuille" };
  if (/emprunt|emprunter|capacite d'endettement/.test(t)) return { kind: "emprunt" };
  if (/depenses?|budget|economies?/.test(t)) return { kind: "depenses" };
  if (/precaution|securite|matelas/.test(t)) return { kind: "precaution" };
  return { kind: "situation" };
}

const months = (m: number | null): string => (m === null ? "indéfiniment" : `${m.toFixed(1).replace(".", ",")} mois`);
const yrs = (y: number | null): string => (y === null ? "hors d'atteinte" : `${y.toFixed(1).replace(".", ",")} ans`);

/** Hypothèses par défaut d'un bien locatif quand l'utilisateur n'en précise aucune : toujours annoncées. */
const DEFAULT_PROPERTY = { prix: 120_000, loyer_mensuel: 650, apport: 15_000 };

export async function runLocalOrchestrator(db: DB, userMessage: string, emit: (event: ChatEvent) => void): Promise<OrchestratorResult> {
  const blocks: Block[] = [];
  const steps: Step[] = [];
  const call = (name: string, input: unknown = {}): Record<string, unknown> => {
    const out = executeTool(name, input, db);
    const step: Step = { agent: out.agent, label: out.label };
    steps.push(step);
    emit({ type: "step", step });
    for (const b of out.blocks) {
      blocks.push(b);
      emit({ type: "block", block: b });
    }
    return out.result as Record<string, unknown>;
  };

  if (buildContext(db).isEmpty) {
    const text = "Je ne connais pas encore ta situation. Commence par renseigner tes comptes et tes revenus dans **Patrimoine**, ou importe une situation de départ depuis **Mémoire** : je pourrai ensuite analyser, simuler et te conseiller à partir de tes vrais chiffres.";
    emit({ type: "text", delta: text });
    return { text, blocks, steps, engine: "local" };
  }

  const intent = detectIntent(userMessage);
  const p: string[] = [];

  switch (intent.kind) {
    case "maj_depenses": {
      const r = call("mettre_a_jour_profil", { autres_depenses_mensuelles: intent.amount, statut: "estime" });
      const ctx = buildContext(db);
      p.push(`C'est noté : **${eur(intent.amount)} de dépenses mensuelles hors loyer** (enregistré comme estimation).`);
      if (typeof r.nouvelle_capacite_epargne === "number") {
        p.push(`Ta capacité d'épargne ressort à **${eur(r.nouvelle_capacite_epargne)} par mois**, soit ${pct(ctx.budget.savingsRate ?? 0)} de ton revenu net.`);
      }
      if (ctx.emergency) {
        p.push(ctx.emergency.level === "insuffisante"
          ? `Ton épargne disponible (${eur(ctx.emergency.liquid)}) couvre ${months(ctx.emergency.monthsCovered)} de dépenses. Le minimum prudent est de ${SAFETY.emergencyMonthsMin.value} mois, soit ${eur(ctx.emergency.targetMin)} : il manque **${eur(ctx.emergency.gapToMin)}**${ctx.budget.savingsCapacity && ctx.budget.savingsCapacity > 0 ? `, que tu peux combler en ${Math.ceil(ctx.emergency.gapToMin / ctx.budget.savingsCapacity)} mois environ en y consacrant toute ta capacité d'épargne` : ""}.`
          : `Ton épargne disponible couvre ${months(ctx.emergency.monthsCovered)} de dépenses : le minimum de précaution est atteint.`);
      }
      p.push("Je peux maintenant chiffrer une stratégie d'investissement mensuel ou un plan vers un objectif de patrimoine.");
      break;
    }
    case "maj_salaire": {
      const r = call("mettre_a_jour_profil", { salaire_net_mensuel: intent.amount, statut: "verifie" });
      p.push(`C'est noté : **salaire net mensuel de ${eur(intent.amount)}**. L'ancienne valeur est conservée dans l'historique de ta mémoire.`);
      if (typeof r.nouvelle_capacite_epargne === "number") p.push(`Ta capacité d'épargne passe à **${eur(r.nouvelle_capacite_epargne)} par mois**. Les plans et décisions qui reposaient sur l'ancien salaire sont réexaminés automatiquement.`);
      break;
    }
    case "allocation": {
      const advice = call("conseiller_allocation", { montant: intent.amount }) as unknown as AllocationAdvice;
      const best = advice.options.find((o) => o.recommended)!;
      p.push(`**Ma recommandation : ${best.title.toLowerCase()}.**`);
      p.push(advice.reasoning.join(" "));
      if (best.id !== "attendre") p.push(`Répartition : ${best.split.map((s) => `${eur(s.amount)} sur ${s.label}`).join(", ")}. À 5 ans, cette option vaudrait entre ${eur(best.valueIn5Years.low)} et ${eur(best.valueIn5Years.high)} selon les scénarios.`);
      p.push("Les quatre options sont comparées ci-dessus, avec leurs avantages et inconvénients. Si tu veux passer à l'acte, dis-le-moi : je préparerai la fiche de l'opération, que tu valideras puis réaliseras toi-même.");
      break;
    }
    case "investissement": {
      const r = call("simuler_investissement", { versement_mensuel: intent.monthly, duree_annees: intent.years }) as { total_verse: number; scenarios: Record<string, { valeur_nette_impots: number; valeur_nette_euros_constants: number }>; monte_carlo: { p10: number; p90: number; probabilite_de_perte: number; baisse_maximale_mediane: number } };
      const ctx = buildContext(db);
      p.push(`En investissant **${eur(intent.monthly)} par mois pendant ${intent.years} ans** dans un ETF actions mondiales via ton PEA, tu aurais versé ${eur(r.total_verse)} et tu pourrais disposer, après impôts, de :`);
      p.push(SCENARIO_NAMES.map((n) => `- **${SCENARIO_LABELS[n]}** (${pct(MARKET.scenarios.value[n])} par an) : ${eur(r.scenarios[n]!.valeur_nette_impots)}, soit ${eur(r.scenarios[n]!.valeur_nette_euros_constants)} en euros d'aujourd'hui`).join("\n"));
      p.push(`Avec des rendements variables d'une année à l'autre, 8 trajectoires simulées sur 10 terminent entre ${eur(r.monte_carlo.p10)} et ${eur(r.monte_carlo.p90)} avant impôts. En chemin, il faut s'attendre à voir le portefeuille baisser d'environ ${pct(r.monte_carlo.baisse_maximale_mediane)} par rapport à un sommet au moins une fois : c'est normal, et c'est la raison pour laquelle cet argent ne doit pas être nécessaire avant longtemps.`);
      if (ctx.budget.savingsCapacity === null) p.push(`**Attention :** je ne connais pas tes dépenses, donc je ne peux pas vérifier que ${eur(intent.monthly)} par mois sont réellement disponibles. Avec ton loyer seul, il te reste au plus ${eur(ctx.budget.savingsCapacityUpperBound ?? 0)} par mois.`);
      else if (intent.monthly > ctx.budget.savingsCapacity) p.push(`**Attention :** ta capacité d'épargne actuelle est de ${eur(ctx.budget.savingsCapacity)} par mois, inférieure à ce versement.`);
      if (ctx.emergency?.level === "insuffisante") p.push(`Avant d'investir à ce rythme, il reste ${eur(ctx.emergency.gapToMin)} à mettre de côté pour atteindre ${SAFETY.emergencyMonthsMin.value} mois d'épargne de précaution.`);
      p.push("Tu peux ajuster le versement et la durée directement dans le simulateur.");
      break;
    }
    case "immobilier": {
      const input = { ...DEFAULT_PROPERTY, duree_annees: intent.years, nombre_biens: intent.units };
      const r = call("comparer_immobilier_bourse", input) as { apport_total: number; dette_totale: number; effort_mensuel_moyen: number; scenarios: { scenario: "prudent" | "central" | "favorable"; realEstateNetWorth: number; etfNetWorth: number; winner: string }[]; faisabilite: string[] };
      const central = r.scenarios.find((s) => s.scenario === "central")!;
      const wins = r.scenarios.filter((s) => s.winner === "immobilier").length;
      p.push(`Tu ne m'as pas donné de bien précis : j'ai retenu une **hypothèse type** — ${intent.units > 1 ? `${intent.units} appartements` : "un appartement"} à ${eur(DEFAULT_PROPERTY.prix)} l'unité, loué ${eur(DEFAULT_PROPERTY.loyer_mensuel)} par mois, avec ${eur(DEFAULT_PROPERTY.apport)} d'apport par bien. Donne-moi un prix, un loyer et un apport réels pour affiner.`);
      p.push(`À effort identique (${eur(r.apport_total)} d'apport puis ${eur(Math.abs(r.effort_mensuel_moyen))} par mois en moyenne), dans ${intent.years} ans et dans le scénario central : **${eur(central.realEstateNetWorth)} côté immobilier contre ${eur(central.etfNetWorth)} côté ETF**. L'immobilier l'emporte dans ${wins} scénario${wins > 1 ? "s" : ""} sur 3.`);
      p.push(`L'écart vient surtout de l'effet de levier : l'immobilier fait travailler ${eur(r.dette_totale)} empruntés, ce qui amplifie le résultat dans les deux sens et ajoute une dette, de la gestion et un risque de vacance.`);
      if (r.faisabilite.length > 0) p.push(`**Faisabilité aujourd'hui :** ${r.faisabilite.join(" ")} Ce scénario est donc un horizon à préparer, pas une décision immédiate.`);
      p.push("Un achat à crédit engage sur vingt ans : avant d'aller plus loin, fais valider le montage par un courtier et un notaire.");
      break;
    }
    case "objectif": {
      const ctx = buildContext(db);
      const monthly = intent.monthly ?? ctx.budget.savingsCapacity ?? ctx.budget.savingsCapacityUpperBound ?? 0;
      const r = call("planifier_objectif", { montant_cible: intent.target, versement_mensuel: monthly, enregistrer: true }) as { plan: GoalPlan };
      const plan = r.plan;
      p.push(`Tu pars de **${eur(plan.current)}**, soit ${pct(plan.progress)} de l'objectif de ${eur(intent.target)}.`);
      if (ctx.budget.savingsCapacity === null && intent.monthly === null) p.push(`Je ne connais pas tes dépenses : j'ai donc pris le **maximum théorique** de ${eur(monthly)} par mois (salaire moins loyer). La durée réelle sera plus longue — indique-moi tes dépenses pour un plan réaliste.`);
      p.push(`En plaçant ${eur(monthly)} par mois, l'objectif serait atteint en **${yrs(plan.byScenario.central.years)}** dans le scénario central (${yrs(plan.byScenario.favorable.years)} si les marchés sont favorables, ${yrs(plan.byScenario.prudent.years)} s'ils sont décevants, ${plan.withoutReturnMonths !== null ? yrs(plan.withoutReturnMonths / 12) : "hors d'atteinte"} sans aucun rendement).`);
      p.push("Les leviers, par ordre d'efficacité à ton niveau de patrimoine : **1.** le montant épargné chaque mois — de loin le premier facteur tant que le capital est modeste ; **2.** la hausse de tes revenus ; **3.** le rendement, qui ne devient déterminant qu'une fois le capital constitué ; **4.** l'effet de levier immobilier, plus rapide mais plus risqué et pas encore finançable aujourd'hui.");
      p.push("J'ai enregistré cet objectif avec ses hypothèses : je suivrai ta progression et je te préviendrai si la réalité s'écarte de la trajectoire prévue.");
      break;
    }
    case "emploi": {
      const r = call("simuler_perte_emploi", { duree_mois: intent.months }) as { erreur?: string; depenses_utilisees: number; depenses_incompletes: boolean; cas: { label: string; monthlyShortfall: number; monthsOnLiquid: number | null; monthsWithInvestments: number | null; survivesPeriod: boolean }[] };
      if (r.erreur) {
        p.push(r.erreur);
        break;
      }
      const [withAid, without] = r.cas as [typeof r.cas[number], typeof r.cas[number]];
      p.push(withAid.monthlyShortfall === 0
        ? `**Avec l'allocation chômage estimée, tu tiens les ${intent.months} mois** : elle couvrirait tes dépenses retenues (${eur(r.depenses_utilisees)} par mois) sans toucher à ton épargne.`
        : `**Avec l'allocation chômage estimée**, il te manquerait ${eur(withAid.monthlyShortfall)} par mois : tes liquidités tiendraient ${months(withAid.monthsOnLiquid)}${withAid.survivesPeriod ? `, assez pour les ${intent.months} mois` : `, pas assez pour ${intent.months} mois`}.`);
      p.push(`**Sans aucun revenu** (fin de droits, démission, délai de versement), tes liquidités tiendraient ${months(without.monthsOnLiquid)}, et ${months(without.monthsWithInvestments)} en vendant aussi tes placements avec une décote.`);
      if (r.depenses_incompletes) p.push("**Ces durées sont trop optimistes** : seul ton loyer est connu. Donne-moi tes dépenses mensuelles pour un calcul fiable.");
      p.push("L'allocation est une approximation : le montant réel dépend de ton salaire brut de référence et de ton ancienneté, à vérifier auprès de France Travail.");
      break;
    }
    case "resistance": {
      const r = call("tester_resistance") as { placements: number; scenarios: { label: string; loss: number; netWorthAfter: number; recoveryYears: number }[] };
      const ctx = buildContext(db);
      const mid = r.scenarios[1]!;
      p.push(`Tes ${eur(r.placements)} de placements sont surtout des actions individuelles. Dans un krach comparable à 2020, la perte estimée serait d'environ **${eur(mid.loss)}**, et ton patrimoine tomberait à ${eur(mid.netWorthAfter)}. Au rendement central et sans nouveau versement, il faudrait environ ${mid.recoveryYears.toFixed(1).replace(".", ",")} ans pour revenir au niveau actuel.`);
      p.push(ctx.emergency?.level === "insuffisante"
        ? `Le vrai risque n'est pas la baisse elle-même, mais d'être obligé de vendre pendant la baisse : avec ${months(ctx.emergency.monthsCovered)} de dépenses en liquidités, un imprévu au mauvais moment transformerait une perte temporaire en perte définitive.`
        : "Ton épargne de précaution te permettrait d'attendre la reprise sans vendre : c'est ce qui rend ce risque supportable.");
      if (ctx.portfolio.coverage < 0.8) p.push("Je ne connais pas la valeur de chaque ligne : ce test raisonne sur le total. Avec le détail, je pourrai isoler les titres les plus risqués.");
      break;
    }
    case "portefeuille": {
      call("analyser_portefeuille");
      const ctx = buildContext(db);
      const pf = ctx.portfolio;
      p.push(`Tes placements totalisent **${eur(pf.investedTotal)}**, soit ${pct(pf.riskyShareOfNetWorth)} de ton patrimoine, répartis sur ${pf.byAccount.length} compte${pf.byAccount.length > 1 ? "s" : ""}.`);
      if (pf.coverage < 0.8) p.push(`Je connais ${ctx.holdings.length} titres par leur nom (${ctx.holdings.map((h) => h.name).join(", ")}), mais pas leur valeur : je ne peux pas mesurer ta diversification réelle ni te dire quelle ligne pèse trop. Renseigne les montants dans **Patrimoine** — je n'invente jamais un cours.`);
      for (const finding of runSpecialists(ctx).filter((x) => x.agent === "Bourse" || x.agent === "Fiscalité").slice(0, 3)) p.push(`**${finding.title}.** ${finding.detail}`);
      break;
    }
    case "depenses": {
      const r = call("analyser_depenses") as { erreur?: string; observe?: { averageMonthly: number; months: number; byCategory: { category: string; averageMonthly: number }[] } };
      const ctx = buildContext(db);
      if (r.erreur || !r.observe) {
        p.push(ctx.otherExpenses !== null
          ? `Je n'ai pas encore de relevé à analyser. D'après ce que tu m'as indiqué, tu dépenses ${eur(ctx.budget.totalExpenses ?? 0)} par mois, loyer compris, pour une capacité d'épargne de ${eur(ctx.budget.savingsCapacity ?? 0)}.`
          : "Je ne connais ni tes dépenses déclarées ni tes relevés. Dis-moi par exemple « mes dépenses mensuelles hors loyer sont d'environ 900 € », ou importe un relevé CSV depuis **Budget**.");
      } else {
        const top = r.observe.byCategory.slice(0, 3);
        p.push(`Sur ${r.observe.months} mois complet${r.observe.months > 1 ? "s" : ""}, tu dépenses en moyenne **${eur(r.observe.averageMonthly)} par mois**. Les trois premiers postes : ${top.map((c) => `${c.category} (${eur(c.averageMonthly)})`).join(", ")}.`);
        const flexible = r.observe.byCategory.filter((c) => ["restaurants", "abonnements", "loisirs", "achats"].includes(c.category));
        if (flexible.length > 0) p.push(`Les postes sur lesquels tu as la main : ${flexible.map((c) => `${c.category} (${eur(c.averageMonthly)})`).join(", ")}. Réduire ces postes de 15 % libérerait environ ${eur(flexible.reduce((s, c) => s + c.averageMonthly, 0) * 0.15)} par mois.`);
      }
      break;
    }
    case "emprunt": {
      const r = call("calculer_capacite_emprunt", { loyer_attendu: 600 }) as { maxPrincipal?: number; maxMonthlyPayment?: number; erreur?: string };
      const ctx = buildContext(db);
      if (r.erreur) p.push(r.erreur);
      else {
        p.push(`En restant locataire, tu pourrais emprunter de l'ordre de **${eur(r.maxPrincipal ?? 0)}** pour un bien locatif, avec une mensualité maximale de ${eur(r.maxMonthlyPayment ?? 0)} assurance incluse. J'ai supposé 600 € de loyer attendu, retenu à 70 % par la banque.`);
        p.push(`La limite n'est pas seulement l'endettement : il faut un apport couvrant au moins les frais de notaire (environ 8 % du prix dans l'ancien). Avec ${eur(ctx.netWorth.liquid)} disponibles, ce n'est pas encore finançable sans entamer ton épargne de précaution.`);
      }
      break;
    }
    case "amortissement": {
      const r = call("tableau_amortissement", { capital: intent.capital, taux: intent.rate, duree_annees: intent.years }) as { mensualite_totale: number; cout_total: number };
      p.push(`Pour ${eur(intent.capital)} empruntés sur ${intent.years} ans à ${pct(intent.rate)}, la mensualité serait de **${eur(r.mensualite_totale)}** assurance incluse, pour un coût total du crédit de ${eur(r.cout_total)}. Le détail année par année est ci-dessus.`);
      break;
    }
    case "precaution": {
      call("analyser_situation");
      const ctx = buildContext(db);
      const e = ctx.emergency;
      if (!e) p.push("Je ne peux pas dimensionner ton épargne de précaution sans connaître tes dépenses mensuelles.");
      else {
        p.push(`Ton épargne disponible est de **${eur(e.liquid)}**, soit ${months(e.monthsCovered)} de dépenses${e.expensesAreLowerBound ? " (calculé sur ton loyer seul, donc surestimé)" : ""}. Repères : ${eur(e.targetMin)} pour ${SAFETY.emergencyMonthsMin.value} mois (minimum), ${eur(e.targetComfort)} pour ${SAFETY.emergencyMonthsComfort.value} mois (confortable).`);
        if (e.gapToMin > 0) p.push(`Il manque ${eur(e.gapToMin)} pour le minimum. Tant que ce seuil n'est pas atteint, chaque euro épargné a plus de valeur en sécurité qu'en Bourse : il t'évite de vendre tes titres au pire moment.`);
      }
      break;
    }
    case "situation": {
      call("analyser_situation");
      p.push(...situationSummary(buildContext(db)));
      break;
    }
  }

  const text = p.filter(Boolean).join("\n\n");
  emit({ type: "text", delta: text });
  return { text, blocks, steps, engine: "local" };
}

function situationSummary(ctx: FinancialContext): string[] {
  const p: string[] = [];
  p.push(`Ton patrimoine net est de **${eur(ctx.netWorth.total)}** au ${ctx.netWorth.oldestAsOf ?? ctx.date} : ${eur(ctx.netWorth.liquid)} d'épargne disponible et ${eur(ctx.netWorth.invested)} de placements, soit ${pct(ctx.portfolio.riskyShareOfNetWorth)} en actifs risqués.`);
  const findings = runSpecialists(ctx).filter((x) => x.severity !== "info").slice(0, 4);
  if (findings.length > 0) {
    p.push("Ce qui mérite ton attention, par ordre de priorité :");
    p.push(findings.map((x, i) => `${i + 1}. **${x.title}** (agent ${x.agent}). ${x.detail}`).join("\n"));
  }
  if (ctx.tax) p.push(`Côté fiscalité, ta tranche marginale est estimée à ${pct(ctx.tax.marginalRate)} ; les gains d'un compte-titres sont taxés à ${pct(TAX.pfuIR.value + TAX.psCapital.value)}.`);
  p.push("Tu peux me demander, par exemple : « J'ai 1 000 € disponibles, qu'en faire ? », « Si j'investis 600 € par mois, combien dans 10 ans ? », « Si je perds mon emploi six mois, combien de temps puis-je tenir ? » ou « Quelle stratégie pour atteindre 100 000 € ? ».");
  return p;
}
