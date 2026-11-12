/**
 * Agents spécialistes. Chacun examine le même contexte daté avec son angle propre et produit
 * des constats chiffrés par le moteur. L'orchestrateur (voir `arbitrate`) les hiérarchise et
 * supprime les contradictions avant qu'ils n'atteignent l'utilisateur ou le modèle.
 */
import { SAFETY, SAVINGS, TAX, borrowingCapacity, eur, goalPlan, pct } from "@/lib/engine";
import type { AgentName } from "./blocks";
import type { FinancialContext } from "./context";

export type Severity = "critique" | "important" | "info";
export type Nature = "fait" | "estimation" | "donnee_manquante" | "hypothese";

export interface Finding {
  key: string;
  agent: AgentName;
  severity: Severity;
  nature: Nature;
  title: string;
  detail: string;
  /** Question que l'utilisateur peut poser en un clic pour approfondir. */
  prompt?: string;
  /** Empreinte de la cause : l'alerte ne revient après avoir été ignorée que si elle change. */
  fingerprint: string;
}

const f = (x: Omit<Finding, "fingerprint"> & { fingerprint?: string | number }): Finding => ({ ...x, fingerprint: String(x.fingerprint ?? x.detail) });

function budgetAgent(ctx: FinancialContext): Finding[] {
  const out: Finding[] = [];
  const checking = ctx.accounts.filter((a) => a.kind === "courant").reduce((s, a) => s + a.balance, 0);
  const hasChecking = ctx.accounts.some((a) => a.kind === "courant");

  if (ctx.otherExpenses === null && ctx.salary !== null) {
    out.push(f({
      key: "budget.depenses_manquantes", agent: "Budget", severity: "important", nature: "donnee_manquante",
      title: "Il manque tes dépenses mensuelles",
      detail: ctx.observedSpending
        ? `Tes relevés indiquent environ ${eur(ctx.observedSpending.averageMonthlyExcludingHousing)} par mois hors logement. Confirme ce chiffre pour que je calcule ta capacité d'investissement.`
        : `Je connais ton salaire (${eur(ctx.salary)}) et ton loyer${ctx.rent !== null ? ` (${eur(ctx.rent)})` : ""}, pas le reste. Sans cela, ta capacité d'investissement réelle est inconnue — au mieux ${eur(ctx.budget.savingsCapacityUpperBound ?? 0)} par mois.`,
      prompt: "Mes dépenses mensuelles hors loyer sont d'environ … €",
      fingerprint: ctx.observedSpending?.averageMonthlyExcludingHousing ?? "aucune",
    }));
  }
  if (hasChecking && checking < 0) {
    out.push(f({ key: "budget.decouvert", agent: "Budget", severity: "critique", nature: "fait", title: "Compte courant à découvert", detail: `Solde de ${eur(checking)}. Les agios coûtent bien plus que ce que rapporte n'importe quel placement : c'est la priorité.`, fingerprint: Math.round(checking / 50) }));
  } else if (hasChecking && ctx.rent !== null && checking < ctx.rent) {
    out.push(f({ key: "budget.risque_decouvert", agent: "Budget", severity: "critique", nature: "fait", title: "Risque de découvert", detail: `Ton compte courant (${eur(checking)}) ne couvre pas ton prochain loyer (${eur(ctx.rent)}).`, prompt: "Comment éviter un découvert ce mois-ci ?", fingerprint: Math.round(checking / 100) }));
  } else if (hasChecking && ctx.budget.totalExpenses !== null && checking < ctx.budget.totalExpenses * 0.5) {
    out.push(f({ key: "budget.risque_decouvert", agent: "Budget", severity: "important", nature: "fait", title: "Compte courant tendu", detail: `Il reste ${eur(checking)} sur ton compte courant, moins de la moitié de tes dépenses mensuelles (${eur(ctx.budget.totalExpenses)}).`, fingerprint: Math.round(checking / 100) }));
  }
  if (ctx.budget.savingsCapacity !== null) {
    if (ctx.budget.savingsCapacity < 0) {
      out.push(f({ key: "budget.deficit", agent: "Budget", severity: "critique", nature: "fait", title: "Tu dépenses plus que tu ne gagnes", detail: `Déficit de ${eur(-ctx.budget.savingsCapacity)} par mois. Aucun investissement ne compense un budget déficitaire.`, prompt: "Où puis-je réduire mes dépenses ?" }));
    } else {
      out.push(f({ key: "budget.capacite", agent: "Budget", severity: "info", nature: "fait", title: `Capacité d'épargne : ${eur(ctx.budget.savingsCapacity)} par mois`, detail: `Soit ${pct(ctx.budget.savingsRate ?? 0)} de ton revenu net.`, prompt: `Si j'investis ${Math.round((ctx.budget.savingsCapacity * 0.6) / 50) * 50} € par mois, combien pourrais-je avoir dans 10 ans ?` }));
    }
  }
  if (ctx.observedSpending && ctx.otherExpenses !== null) {
    const observed = ctx.observedSpending.averageMonthlyExcludingHousing;
    if (ctx.otherExpenses > 0 && Math.abs(observed - ctx.otherExpenses) / ctx.otherExpenses > 0.2) {
      out.push(f({ key: "budget.ecart_declare_observe", agent: "Budget", severity: "important", nature: "fait", title: "Tes dépenses réelles s'écartent de ton estimation", detail: `Tu as déclaré ${eur(ctx.otherExpenses)} par mois hors loyer ; tes relevés montrent ${eur(observed)} en moyenne sur ${ctx.observedSpending.months} mois. Les plans construits sur l'ancienne valeur sont à revoir.`, prompt: "Analyse mes dépenses des derniers mois", fingerprint: Math.round(observed / 50) }));
    }
  }
  // Dépense inhabituelle : plus de trois fois la médiane de sa catégorie, sur les 30 derniers jours.
  const recentLimit = new Date(Date.parse(ctx.date) - 30 * 86_400_000).toISOString().slice(0, 10);
  const expenses = ctx.transactions.filter((t) => t.amount < 0 && t.category !== "épargne et placements" && t.category !== "logement");
  for (const t of expenses.filter((t) => t.date >= recentLimit)) {
    const peers = expenses.filter((p) => p.category === t.category && p.id !== t.id).map((p) => -p.amount).sort((a, b) => a - b);
    if (peers.length < 5) continue;
    const median = peers[Math.floor(peers.length / 2)]!;
    if (-t.amount > Math.max(200, median * 3)) {
      out.push(f({ key: `budget.inhabituelle.${t.id}`, agent: "Budget", severity: "important", nature: "fait", title: "Dépense inhabituelle", detail: `${t.label} : ${eur(-t.amount)} le ${t.date}, contre ${eur(median)} habituellement en « ${t.category} ».`, fingerprint: t.id }));
    }
  }
  return out;
}

function patrimoineAgent(ctx: FinancialContext): Finding[] {
  const out: Finding[] = [];
  const e = ctx.emergency;
  const risky = ctx.portfolio.riskyShareOfNetWorth;
  if (e && ctx.netWorth.invested > 0 && (e.level === "insuffisante" || (e.level === "minimale" && risky > 0.5))) {
    const short = e.level === "insuffisante";
    out.push(f({
      key: "patrimoine.precaution", agent: "Patrimoine", severity: "important", nature: e.expensesAreLowerBound ? "estimation" : "fait",
      title: "Ton épargne disponible est faible par rapport à tes investissements risqués",
      detail: `${eur(e.liquid)} disponibles pour ${eur(ctx.netWorth.invested)} placés en Bourse (${pct(risky)} de ton patrimoine). Cela couvre ${e.monthsCovered.toFixed(1).replace(".", ",")} mois ${e.expensesAreLowerBound ? "de loyer seul — avec tes autres dépenses, sans doute moins que le minimum prudent de" : `de dépenses, ${short ? "sous" : "juste au-dessus du"} minimum prudent de`} ${SAFETY.emergencyMonthsMin.value} mois${short ? ` (${eur(e.targetMin)})` : ""}. En cas d'imprévu, tu devrais vendre des titres, peut-être au pire moment.`,
      prompt: "Comment renforcer mon épargne de précaution ?",
      fingerprint: `${e.level}:${Math.round(e.monthsCovered * 2)}`,
    }));
  } else if (e && e.level === "insuffisante") {
    out.push(f({ key: "patrimoine.precaution", agent: "Patrimoine", severity: "important", nature: "fait", title: "Épargne de précaution insuffisante", detail: `${e.monthsCovered.toFixed(1).replace(".", ",")} mois de dépenses couverts ; il manque ${eur(e.gapToMin)} pour atteindre ${SAFETY.emergencyMonthsMin.value} mois.`, fingerprint: Math.round(e.monthsCovered * 2) }));
  }
  if (ctx.stale.length > 0) {
    out.push(f({ key: "patrimoine.donnees_anciennes", agent: "Patrimoine", severity: "info", nature: "fait", title: "Certaines données datent", detail: `À mettre à jour : ${ctx.stale.slice(0, 3).join(" ; ")}${ctx.stale.length > 3 ? "…" : ""}.`, fingerprint: ctx.stale.length }));
  }
  return out;
}

function bourseAgent(ctx: FinancialContext): Finding[] {
  const out: Finding[] = [];
  const p = ctx.portfolio;
  if (p.investedTotal <= 0) return out;
  if (p.coverage < 0.8) {
    out.push(f({
      key: "bourse.composition_inconnue", agent: "Bourse", severity: "important", nature: "donnee_manquante",
      title: "Je ne connais pas le détail de ton portefeuille",
      detail: `${eur(p.undetailedValue)} sur ${eur(p.investedTotal)} de placements ne sont rattachés à aucune ligne valorisée${ctx.holdings.length > 0 ? ` (${ctx.holdings.length} titres identifiés, sans montant)` : ""}. Je ne peux donc ni mesurer ta diversification ni chiffrer ton risque titre par titre.`,
      prompt: "Je veux renseigner la valeur de mes lignes de portefeuille",
      fingerprint: Math.round(p.coverage * 10),
    }));
  }
  if (p.topLine && p.lines.length > 1 && p.topLine.weight > SAFETY.concentrationWarn.value) {
    out.push(f({ key: "bourse.concentration", agent: "Bourse", severity: "important", nature: "fait", title: `Concentration sur ${p.topLine.name}`, detail: `Cette ligne représente ${pct(p.topLine.weight)} de ton portefeuille valorisé (seuil d'alerte : ${pct(SAFETY.concentrationWarn.value)}). Une mauvaise nouvelle sur ce seul titre pèserait lourd.`, prompt: `Comment réduire ma concentration sur ${p.topLine.name} ?`, fingerprint: `${p.topLine.name}:${Math.round(p.topLine.weight * 10)}` }));
  }
  const stocks = ctx.holdings.filter((h) => h.assetClass === "action");
  if (stocks.length >= 3 && stocks.length / Math.max(1, ctx.holdings.length) > 0.7) {
    const sectors = new Map<string, number>();
    for (const h of stocks) if (h.sector) sectors.set(h.sector, (sectors.get(h.sector) ?? 0) + 1);
    const tech = [...sectors.entries()].filter(([s]) => /tech|semi/i.test(s)).reduce((a, [, n]) => a + n, 0);
    out.push(f({
      key: "bourse.actions_individuelles", agent: "Bourse", severity: "info", nature: "fait",
      title: "Portefeuille surtout composé d'actions individuelles",
      detail: `${stocks.length} titres sur ${ctx.holdings.length} sont des actions en direct${tech >= 3 ? `, dont ${tech} dans la technologie et les semi-conducteurs, des secteurs qui montent et baissent souvent ensemble` : ""}. Le risque est nettement plus élevé qu'avec un indice large.`,
      prompt: "Fais un test de résistance de mon portefeuille",
      fingerprint: `${stocks.length}/${ctx.holdings.length}`,
    }));
  }
  return out;
}

function fiscaliteAgent(ctx: FinancialContext): Finding[] {
  const out: Finding[] = [];
  const pea = ctx.accounts.filter((a) => a.kind === "pea").reduce((s, a) => s + a.balance, 0);
  const cto = ctx.accounts.filter((a) => a.kind === "cto").reduce((s, a) => s + a.balance, 0);
  if (ctx.accounts.some((a) => a.kind === "pea") && cto > 1000 && pea < cto * 0.25) {
    out.push(f({
      key: "fiscalite.pea_sous_utilise", agent: "Fiscalité", severity: "info", nature: "fait",
      title: "Ton PEA est peu utilisé",
      detail: `${eur(pea)} sur ton PEA contre ${eur(cto)} sur des comptes-titres, où les gains sont taxés à ${pct(TAX.pfuIR.value + TAX.psCapital.value)}. Après 5 ans, les gains d'un PEA ne supportent que ${pct(TAX.psCapital.value)} de prélèvements sociaux. Attention : le PEA n'accepte que des titres européens ou des ETF éligibles — tes actions américaines et japonaises n'y sont pas logeables en direct.`,
      prompt: "Faut-il privilégier mon PEA pour mes prochains investissements ?",
      fingerprint: `${Math.round(pea / 500)}:${Math.round(cto / 500)}`,
    }));
  }
  const lep = ctx.accounts.find((a) => a.kind === "livret" && /lep/i.test(a.name));
  if (lep && ctx.tax && ctx.tax.taxable > 23_000 * ctx.tax.parts) {
    out.push(f({
      key: "fiscalite.lep_eligibilite", agent: "Fiscalité", severity: "important", nature: "estimation",
      title: "Ton éligibilité au LEP est à vérifier",
      detail: `Le LEP (${pct(SAVINGS.lep.value)} net) est réservé aux foyers sous un plafond de revenu fiscal de référence, de l'ordre de 23 000 € pour une part. Avec ${eur(ctx.salary ?? 0)} nets par mois, ton revenu fiscal estimé est d'environ ${eur(ctx.tax.taxable)}. Si tu dépasses le plafond deux années de suite, la banque doit clôturer le livret : vérifie ton dernier avis d'imposition avant d'en faire le pilier de ton épargne de précaution.`,
      prompt: "Que faire si je ne suis plus éligible au LEP ?",
      fingerprint: Math.round(ctx.tax.taxable / 1000),
    }));
  }
  return out;
}

function immobilierAgent(ctx: FinancialContext): Finding[] {
  if (ctx.salary === null || ctx.rent === null) return [];
  const cap = borrowingCapacity({ netMonthlyIncome: ctx.salary, existingMonthlyCharges: ctx.rent, expectedMonthlyRent: 600 });
  return [f({
    key: "immobilier.capacite", agent: "Immobilier", severity: "info", nature: "estimation",
    title: "Je peux comparer plusieurs façons de constituer un apport immobilier",
    detail: `En restant locataire, ta capacité d'emprunt pour un bien locatif est de l'ordre de ${eur(cap.maxPrincipal)} sur ${cap.assumptions.years} ans (règle des ${pct(cap.debtRatioUsed)}, loyers futurs comptés à ${pct(cap.assumptions.rentalIncomeWeight)}). Il faut en plus un apport couvrant au moins les frais de notaire, que ton épargne actuelle ne permet pas encore.`,
    prompt: "Si j'achète un appartement pour le louer, serai-je plus riche qu'en investissant en ETF ?",
    fingerprint: Math.round(cap.maxPrincipal / 5000),
  })];
}

function strategieAgent(ctx: FinancialContext): Finding[] {
  const out: Finding[] = [];
  if (ctx.goals.length === 0 && ctx.accounts.length > 0) {
    out.push(f({ key: "strategie.pas_d_objectif", agent: "Stratégie", severity: "info", nature: "donnee_manquante", title: "Fixons un cap chiffré", detail: "Tu veux développer ton patrimoine, mais aucun objectif chiffré n'est enregistré. Avec une cible et une échéance, je peux construire un plan, mémoriser ses hypothèses et suivre ta progression.", prompt: "Quelle stratégie pour atteindre 100 000 € de patrimoine le plus rapidement ?" }));
  }
  for (const g of ctx.goals.filter((g) => g.status === "actif")) {
    if (g.progress >= 1) {
      out.push(f({ key: `strategie.objectif_atteint.${g.id}`, agent: "Stratégie", severity: "important", nature: "fait", title: `Objectif atteint : ${g.title}`, detail: `Ton patrimoine (${eur(g.current)}) a atteint la cible de ${eur(g.targetAmount)}. C'est le moment de fixer l'étape suivante.`, fingerprint: "atteint" }));
    } else if (g.monthlyContribution && g.monthlyContribution > 0) {
      const plan = goalPlan(g.current, g.monthlyContribution, g.targetAmount);
      const months = plan.byScenario.central.months;
      if (months !== null && months <= 12) {
        out.push(f({ key: `strategie.objectif_proche.${g.id}`, agent: "Stratégie", severity: "important", nature: "hypothese", title: `Objectif « ${g.title} » à portée`, detail: `Au rythme de ${eur(g.monthlyContribution)} par mois, la cible de ${eur(g.targetAmount)} pourrait être atteinte dans environ ${months} mois (scénario central, non garanti).`, fingerprint: Math.ceil(months / 3) }));
      }
    }
  }
  for (const c of ctx.forecastChecks) {
    if (Math.abs(c.gap) > Math.max(500, c.projected * 0.1)) {
      out.push(f({ key: `strategie.ecart_prevision.${c.goal}`, agent: "Stratégie", severity: "important", nature: "fait", title: `Écart avec ma prévision pour « ${c.goal} »`, detail: `J'avais projeté ${eur(c.projected)} au ${c.date} (scénario central) ; ton patrimoine observé est de ${eur(c.actual)}, soit ${c.gap >= 0 ? "+" : "−"}${eur(Math.abs(c.gap))}. Le plan mérite d'être recalculé.`, prompt: `Réévalue mon plan pour l'objectif « ${c.goal} »`, fingerprint: Math.round(c.gap / 500) }));
    }
  }
  // Décision passée dont les hypothèses chiffrées ne tiennent plus.
  for (const d of ctx.decisions.filter((d) => d.status === "active")) {
    const a = d.assumptions as { salaireNetMensuel?: number; depensesMensuelles?: number };
    const drift: string[] = [];
    if (a.salaireNetMensuel && ctx.salary !== null && Math.abs(ctx.salary - a.salaireNetMensuel) / a.salaireNetMensuel > 0.1) drift.push(`salaire ${eur(a.salaireNetMensuel)} → ${eur(ctx.salary)}`);
    if (a.depensesMensuelles && ctx.budget.totalExpenses !== null && Math.abs(ctx.budget.totalExpenses - a.depensesMensuelles) / a.depensesMensuelles > 0.15) drift.push(`dépenses ${eur(a.depensesMensuelles)} → ${eur(ctx.budget.totalExpenses)}`);
    if (drift.length > 0) {
      out.push(f({ key: `strategie.hypotheses_caduques.${d.id}`, agent: "Stratégie", severity: "important", nature: "fait", title: `Une décision repose sur des hypothèses dépassées`, detail: `« ${d.title} » (${d.date}) supposait : ${drift.join(" ; ")}. Elle est à réexaminer.`, prompt: `Réexamine ma décision « ${d.title} »`, fingerprint: drift.join("|") }));
    }
  }
  return out;
}

const ORDER: Record<Severity, number> = { critique: 0, important: 1, info: 2 };

/**
 * Arbitrage de l'orchestrateur : sécurité financière d'abord, puis qualité des données,
 * puis optimisation. Les suggestions d'investissement sont retirées tant qu'un problème
 * de trésorerie est ouvert, pour qu'aucun agent ne contredise l'agent Budget.
 */
export function arbitrate(findings: Finding[]): Finding[] {
  const cashProblem = findings.some((x) => ["budget.decouvert", "budget.risque_decouvert", "budget.deficit"].includes(x.key) && x.severity === "critique");
  const kept = cashProblem ? findings.filter((x) => !["immobilier.capacite", "fiscalite.pea_sous_utilise", "strategie.pas_d_objectif"].includes(x.key)) : findings;
  return [...kept].sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
}

export function runSpecialists(ctx: FinancialContext): Finding[] {
  if (ctx.isEmpty) return [];
  return arbitrate([...budgetAgent(ctx), ...patrimoineAgent(ctx), ...bourseAgent(ctx), ...fiscaliteAgent(ctx), ...immobilierAgent(ctx), ...strategieAgent(ctx)]);
}
