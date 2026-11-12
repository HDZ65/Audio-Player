# Mon IA financière

Un assistant financier personnel : on ouvre l'application, on lui parle, et il répond à partir de sa situation réelle — comptes, budget, portefeuille, objectifs — avec des analyses chiffrées, des simulations et des recommandations argumentées.

Ce n'est pas un logiciel de comptabilité doté d'un chatbot. L'écran principal est la conversation ; les modules de gestion (patrimoine, budget, objectifs, simulateurs, mémoire) sont en navigation secondaire.

> Analyses informatives. Ce logiciel n'est pas un conseiller en investissements financiers et ne fournit pas de conseil réglementé. Il n'exécute aucune opération financière.

## Démarrer

```bash
npm install
cp .env.example .env.local                                   # optionnel : clé API, mot de passe
cp seed/situation.exemple.json seed/situation.local.json     # puis y mettre ses vrais chiffres
npm run dev                                                  # http://localhost:3000
```

Au premier lancement, `seed/situation.local.json` est importé s'il existe. Sinon, l'application démarre vide et propose de saisir ses comptes ou de coller une situation de départ (page Mémoire).

**Les données personnelles ne sont jamais versionnées** : la base (`data/*.db`) et `seed/*.local.json` sont dans `.gitignore`.

| Commande | Rôle |
|---|---|
| `npm run dev` / `npm run build && npm start` | Développement / production |
| `npm run dev:https` | Développement en HTTPS local, requis pour la connexion bancaire |
| `npm test` | Tests (moteur, mémoire, agents, outils, connecteurs, import, sécurité) |
| `npm run typecheck` | Vérification des types |
| `npm run seed -- fichier.json` | Importer une situation de départ dans une base vide |

### Deux modes de fonctionnement

| | Avec `ANTHROPIC_API_KEY` | Sans clé (mode local) |
|---|---|---|
| Compréhension | N'importe quelle question, raisonnement libre | Demandes types reconnues par règles |
| Calculs | Moteur déterministe | Le même moteur, les mêmes chiffres |
| Confidentialité | La situation chiffrée est envoyée à l'API Anthropic | Rien ne quitte la machine |
| Recherche web | Possible (`ENABLE_WEB_SEARCH=true`), sources citées | Non |

Si l'API est indisponible, l'assistant bascule sur le mode local en le disant.

## Connecter ses comptes

Tout passe par la page **Connexions**, uniquement par des voies autorisées et en lecture seule.

### Banque (BoursoBank et autres) — agrégateur agréé DSP2

L'application utilise [Enable Banking](https://enablebanking.com). Tu t'identifies sur le site de ta banque ; l'application ne voit jamais tes identifiants et ne reçoit que soldes et opérations. Aucun service de paiement n'est appelé.

1. Crée un compte sur enablebanking.com, puis une application en environnement **Production**.
2. Déclare l'adresse de retour `APP_URL/api/bank/callback`, soit `https://localhost:3000/api/bank/callback` en local. L'agrégateur refuse les adresses `http://` : lance alors l'application avec `npm run dev:https` (certificat local généré au premier lancement).
3. Active l'application en y associant tes propres comptes (mode « restreint », réservé à tes comptes).
4. Lance `npm run dev:https`, ouvre la page Connexions et donne-lui le fichier `.pem` téléchargé à la création, sans le renommer : son nom est l'identifiant de l'application. Il est rangé dans `secrets/` (ignoré par git) ; aucune variable d'environnement n'est nécessaire.
5. Choisis ta banque dans la liste.

À savoir :

- La DSP2 couvre les comptes de paiement (compte courant, parfois les livrets). PEA, comptes-titres et assurances-vie ne sont généralement pas accessibles par cette voie.
- L'autorisation doit être renouvelée périodiquement (180 jours au plus) ; l'assistant le signale.
- La synchronisation se fait à l'ouverture de l'application, au plus toutes les 12 heures, et à la demande.
- Seuls les quatre derniers caractères de l'IBAN sont conservés.

### Trade Republic — export CSV officiel

Trade Republic ne propose pas d'API publique pour le portefeuille. La voie prévue par le courtier est l'export natif : dans l'application, **Profil → Relevés → Export des transactions**, période « depuis le début ». L'import affiche un aperçu avant d'écrire quoi que ce soit, puis :

- reconstitue les positions (quantités, prix de revient au prix moyen pondéré) ;
- importe dividendes, intérêts et mouvements d'espèces, sans doublon d'un import à l'autre ;
- remplace les lignes du même titre saisies à la main et conserve les valeurs de marché déjà renseignées.

L'export ne contient pas de cours : la valeur actuelle de chaque ligne reste à saisir. Un prix de revient n'est jamais présenté comme une valorisation.

Si Trade Republic figure dans la liste des banques de l'agrégateur, son compte espèces peut aussi être relié comme une banque.

**Ce qui n'est volontairement pas fait** : se connecter avec le numéro de téléphone et le code de l'utilisateur en imitant l'application du courtier (bibliothèques non officielles). Cela contourne sa sécurité et ses conditions d'utilisation.

## Architecture

```
src/
├─ lib/engine/      Moteur de calcul : pur, sans dépendance, partagé serveur / navigateur
│   ├─ params.ts      Hypothèses fiscales et de marché, chacune datée, sourcée et qualifiée
│   ├─ projection.ts  Investissement programmé : frais, fiscalité de sortie (PEA / CTO), inflation, 3 scénarios
│   ├─ montecarlo.ts  Rendements variables, reproductible (graine fixe)
│   ├─ loan.ts        Crédit : mensualité, amortissement, capacité d'emprunt (règle des 35 %)
│   ├─ realestate.ts  Locatif année par année : vacance, charges, régimes fiscaux, plus-value à la revente
│   ├─ compare.ts     Immobilier ou ETF à effort d'épargne identique
│   └─ analysis.ts    Patrimoine net, budget, précaution, portefeuille, tests de résistance, objectifs, allocation
├─ lib/db/          SQLite : schéma versionné, dépôt de données, import de la situation de départ
├─ lib/ai/
│   ├─ context.ts     Photographie datée de la situation — source unique des agents et de l'interface
│   ├─ specialists.ts Agents Budget, Patrimoine, Bourse, Fiscalité, Immobilier, Stratégie + arbitrage
│   ├─ tools.ts       17 outils : entrées validées, calculs délégués au moteur, blocs visuels en sortie
│   ├─ orchestrator.ts Boucle Claude : choisit les outils, croise les résultats, rédige
│   ├─ local.ts       Orchestrateur de secours, sans modèle
│   └─ blocks.ts      Blocs riches de la conversation (graphiques, simulateur, comparatifs, fiches d'opération)
├─ lib/monitor/     Alertes : ne retient que l'important, respecte ce qui a été ignoré
├─ lib/connectors/  Banque en lecture seule (Enable Banking), synchronisation, import Trade Republic
├─ lib/budget/      Import CSV bancaire et classement des opérations
├─ lib/security/    Session signée
├─ proxy.ts         Authentification et contrôle d'origine sur chaque requête
└─ app/             Pages et API (Next.js)
```

### Principes de conception

**Les modèles raisonnent, le moteur calcule.** Aucun chiffre financier n'est produit par le modèle. Il appelle des outils ; chaque outil valide ses entrées puis délègue au moteur. Les graphiques et tableaux affichés viennent directement des outils, pas du texte du modèle.

**Multi-agents, là où cela sert.** Les spécialistes sont des modules d'analyse déterministes qui examinent le même contexte daté. Un seul modèle orchestre : il n'y a donc pas plusieurs modèles susceptibles de se contredire, et le coût reste celui d'une conversation. L'arbitrage est explicite — sécurité financière, puis qualité des données, puis optimisation : tant qu'un problème de trésorerie est ouvert, les suggestions d'investissement sont retirées.

**Une mémoire qui sait ce qu'elle ne sait pas.** Chaque fait porte un statut (vérifié, estimation, manquant), une source et une date ; l'ancienne valeur est conservée. Une information absente est enregistrée comme manquante, jamais devinée. Les soldes sont des photographies datées.

**Aucun cours inventé.** La valeur d'une ligne est celle que l'utilisateur saisit, avec sa date. Sans elle, l'analyse dit qu'elle est partielle.

**Des fourchettes, pas des promesses.** Toute projection présente trois scénarios, nets de frais, d'impôts et d'inflation, complétés par une simulation à rendements variables et des tests de résistance.

**Lire, préparer, exécuter : trois niveaux distincts.** L'assistant lit et prépare. Une opération financière n'est jamais qu'une fiche à valider ; l'application ne se connecte à aucune banque. Les écritures dans la mémoire sont tracées dans un journal avec leur auteur.

**Suivi dans le temps.** Un objectif enregistre ses hypothèses et sa trajectoire prévue ; chaque changement de solde alimente l'historique du patrimoine ; les prévisions échues sont comparées au réel ; une décision dont les hypothèses ont dérivé est signalée.

## Sécurité et confidentialité

- Base SQLite locale, fichier en lecture restreinte au propriétaire ; aucun identifiant bancaire demandé ni stocké.
- `APP_PASSWORD` active une authentification par session signée (cookie `HttpOnly`, `SameSite=Strict`), avec limitation des tentatives. **À définir avant toute mise en ligne.**
- Contrôle d'origine sur les écritures, validation de toutes les entrées, en-têtes de sécurité (CSP, anti-clickjacking).
- Export complet et effacement complet depuis la page Mémoire.
- La clé API reste côté serveur. Le contexte transmis au modèle contient des montants et des libellés, pas d'identifiants.

## Limites connues de cette version

- Connexion bancaire : testée contre un faux service conforme à la documentation et, pour l'authentification, contre l'API réelle ; pas encore contre une vraie banque. La couverture de chaque banque dépend de l'agrégateur.
- Import Trade Republic : écrit d'après des descriptions publiques du format, tolérant sur le nom des colonnes ; à valider sur un export réel.
- Pas de cours de Bourse : valorisations saisies à la main.
- La surveillance s'exécute à l'ouverture de l'application et après chaque modification, pas en tâche de fond.
- Fiscalité simplifiée et signalée comme telle : LMNP au réel (amortissements) non modélisé, déficit foncier reporté sans imputation sur le revenu global, allocation chômage approximée. Certains paramètres 2026 sont marqués « à vérifier ».
- Application mono-utilisateur.

## Feuille de route

1. Agrégation des placements (PEA, comptes-titres) par un prestataire agréé couvrant l'épargne financière.
2. Cours et données de marché depuis une source sous licence, horodatés.
3. Surveillance planifiée et notifications.
4. Rapport patrimonial exportable ; parcours guidé d'un projet immobilier.
5. Fiscalité étendue : assurance-vie, PER, LMNP au réel.
