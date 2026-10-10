# Contexte projet

## Vision produit

`github-issues` est une extension OpenChamber locale : un panneau qui liste les issues GitHub du projet ouvert, via la CLI `gh`. Sur chaque issue :

- **Implement** : ouvre une nouvelle session liée à l'issue, avec un court prompt qui demande à l'agent de la corriger.
- **Commit** : ouvre un composer inline qui fait `git add -A` puis `git commit` avec un mot-clé de fermeture GitHub (`Closes #N`), pour que l'issue se ferme quand le commit arrive sur la branche par défaut. Un commentaire optionnel est posté sur l'issue avec le SHA.

Le panneau est une iframe sandboxée : il ne peut lancer ni `gh` ni `git`. Le service local du package exécute ces deux binaires ; c'est sa seule raison d'être.

## Architecture synthétique

Le projet est un package autonome à la racine de ce dépôt (hors monorepo).

Fichiers clés :

- `panel/index.html` : page hôte du panel (point d'entrée déclaré).
- `panel/main.ts` : logique du panel (bundlé en `panel/main.js`, IIFE navigateur minifié).
- `service/main.ts` : service local HTTP qui lance `gh` et `git` (bundlé en `service/main.js`, ESM Node non minifié).
- `src/issue.js` : numéro d'issue, normalisation d'un item `gh issue list`, filtre de recherche.
- `src/prompt.js` : prompt « Implement ».
- `src/commit.js` : mots-clés de fermeture, sujet par défaut, message de commit, commentaire d'issue.
- `src/changes.js` : lecture de `git status --porcelain=v1 -z`.
- `tests/*.test.js` : tests Node natifs (`node --test`).
- `package.json` : manifeste OpenChamber (`openchamber.contributes`) + scripts.
- `README.md` : documentation utilisateur.

Routes du service :

| Méthode | Route | Rôle |
| --- | --- | --- |
| GET | `/health` | Sonde de démarrage du host |
| GET | `/issues?directory&state=open\|closed` | Issues (100 max), dépôt et branche par défaut via `gh` |
| GET | `/changes?directory` | Branche courante et fichiers modifiés via `git status` |
| POST | `/commit?directory` | `git add -A`, `git commit`, puis commentaire optionnel via `gh issue comment` |

Codes : 400 entrée invalide ou dossier non Git, 409 rien à committer, 422 échec de `git` (hook, identité), 502 échec de `gh` (pas un dépôt GitHub, non authentifié). Toute autre route répond 404, toute mauvaise méthode 405, toute requête sans jeton 401.

## Commandes

Depuis la racine du package :

```bash
bun install
bun run build
bun run test
bun run check
```

- `bun run build` régénère `panel/main.js` et `service/main.js` via `openchamber-guest-bundle`.
- `bun run check` enchaîne le syntax check des modules `src/*.js` et des bundles, puis les tests.
- Les bundles `panel/main.js` et `service/main.js` sont **committés** : tout changement de `panel/main.ts` ou `service/main.ts` doit être suivi d'un `bun run build`.

## Règles techniques

- Les modules `src/*.js` sont du JavaScript ESM pur, sans import Node ; ils sont couverts par `node --test`.
- Le panneau repaint une section uniquement quand sa signature change (classe `Block`) ; les champs de saisie sont montés une fois et hors de toute signature.
- Le panneau n'utilise que `connectHost()` (`serviceRequest`, `startSession`, `openUrl`, `toast`) et les primitives `@openchamber/sdk/ui`.
- Le service se bind sur `127.0.0.1` et exige le jeton Bearer `OPENCHAMBER_SERVICE_TOKEN` sur chaque requête.
- **`execFile` uniquement, jamais de shell** : arguments en tableau, `cwd` = dossier validé, timeout (30 s ; 120 s pour `git commit` à cause des hooks), `maxBuffer` 8 Mo, prompts interactifs désactivés (`GH_PROMPT_DISABLED`, `GIT_TERMINAL_PROMPT=0`). Le message de commit et le commentaire passent par stdin.
- **Validation du dossier** : `directory` obligatoire, absolu, sans NUL, résolu, existant et de type dossier. Le service ne fait pas confiance au panneau.
- **Ordre commit puis commentaire** : le commentaire n'est posté qu'après un commit réussi, avec son SHA. Un commentaire en échec ne défait jamais le commit : réponse 200 avec `commentError`.
- Une liste de fichiers tronquée par `CHANGES_MAX` est un résultat partiel (`truncated`), pas une erreur ; le commit inclut tous les fichiers.
- Ne pas ajouter de modal ; le composer de commit est inline.
- Aucun survol ne déplace un élément (pas de translate/scale/rotate).

## Critères de validation

- `bun run check` passe.
- Service vérifié en conditions réelles : 401 sans jeton, 404/405, 400 sur dossier relatif, `/changes` liste les fichiers, `POST /commit` produit `Closes #N`, second commit 409, mot-clé invalide 400, `/issues` en 502 lisible hors dépôt GitHub.
- Panel vérifié avec un hôte simulé : liste, filtre, onglets, composer, Implement (nouvelle session).
- Ne jamais poster de vrai commentaire GitHub pendant les tests (commentaire vide).
- Ne pas commit, push ni deploy : ces actions reviennent à l'utilisateur.
