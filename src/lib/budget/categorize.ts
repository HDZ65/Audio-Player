/** Classement des opérations par règles de mots-clés : simple, explicable, corrigeable à la main. */

export const CATEGORIES = [
  "revenus", "logement", "courses", "restaurants", "transport", "abonnements", "santé", "assurances", "impôts",
  "loisirs", "achats", "épargne et placements", "retraits", "frais bancaires", "non classé",
] as const;
export type Category = (typeof CATEGORIES)[number];

const RULES: [Category, RegExp][] = [
  ["revenus", /\b(salaire|paie|remuneration|france travail|pole emploi|caf|cpam|remboursement)\b/],
  ["logement", /\b(loyer|foncia|nexity|edf|engie|totalenergies elec|eau de|veolia|charges copro|habitation)\b/],
  ["courses", /\b(carrefour|leclerc|lidl|auchan|monoprix|intermarche|franprix|casino|picard|biocoop|aldi|super u|u express|naturalia)\b/],
  ["restaurants", /\b(restaurant|resto|uber ?eats|deliveroo|just ?eat|mcdo|mcdonald|burger|kfc|starbucks|boulangerie|brasserie|cafe)\b/],
  ["transport", /\b(sncf|ratp|navigo|uber|bolt|blablacar|essence|total|esso|shell|bp|peage|vinci|parking|velib|lime|toosla|getaround)\b/],
  ["abonnements", /\b(netflix|spotify|deezer|disney|canal|amazon prime|prime video|free|orange|sfr|bouygues|sosh|red by|icloud|google one|youtube|chatgpt|openai|anthropic|claude)\b/],
  ["santé", /\b(pharmacie|medecin|docteur|doctolib|dentiste|opticien|mutuelle|hopital|laboratoire)\b/],
  ["assurances", /\b(assurance|maif|macif|axa|allianz|matmut|groupama|maaf|gmf)\b/],
  ["impôts", /\b(dgfip|impot|impots|tresor public|taxe)\b/],
  ["loisirs", /\b(cinema|ugc|pathe|fnac spectacle|concert|steam|playstation|nintendo|salle de sport|basic fit|fitness|voyage|booking|airbnb|hotel)\b/],
  ["achats", /\b(amazon|fnac|darty|zalando|vinted|ikea|decathlon|leroy merlin|zara|h&m|uniqlo|shein|apple store|boulanger|cdiscount)\b/],
  ["épargne et placements", /\b(lep|livret|pea|bourse|trade republic|degiro|interactive brokers|virement interne|epargne|vir .* compte titres)\b/],
  ["retraits", /\b(retrait|dab)\b/],
  ["frais bancaires", /\b(frais|commission|cotisation carte|agios)\b/],
];

const normalize = (s: string): string => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

export function categorize(label: string, amount: number): Category {
  const text = normalize(label);
  for (const [category, pattern] of RULES) {
    if (category === "revenus" && amount <= 0) continue;
    if (pattern.test(text)) return category;
  }
  return amount > 0 ? "revenus" : "non classé";
}

/** Catégories exclues du calcul des dépenses : ce sont des mouvements entre mes propres comptes. */
export const NON_SPENDING: readonly string[] = ["épargne et placements", "revenus"];
